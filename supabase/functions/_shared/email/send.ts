// Reusable, server-only email sender built on the Resend REST API.
//
//  - RESEND_API_KEY is read from edge-function secrets and never leaves the server.
//  - Every attempt is written to public.email_logs (no links, tokens or passwords).
//  - Duplicates are suppressed atomically via public.claim_email_send().
//  - Templates can be switched off or reworded by admins (public.email_templates).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type EmailConfig, getEmailConfig, maskEmail } from "./config.ts";
import { type RenderedEmail, renderEmail, type Vars } from "./render.ts";
import { EDITABLE_FIELDS, type EditableField, effectiveContent, type TemplateKey, TEMPLATES } from "./templates.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const LOGO_CID = "majr-logo";

export interface SendTemplatedEmailOptions {
  templateKey: TemplateKey;
  to: string;
  variables: Vars;
  recipientUserId?: string | null;
  /** Identical keys within the window are sent only once. */
  dedupeKey?: string | null;
  /** Seconds; null = forever. Ignored without dedupeKey. Default 120. */
  dedupeWindowSeconds?: number | null;
  /** Non-secret references (ids) used to rebuild and resend this email. */
  context?: Record<string, unknown>;
  triggeredBy?: string | null;
  resentFrom?: string | null;
  subjectPrefix?: string;
  /** Admin test sends: render this draft wording instead of the saved one. */
  contentOverride?: Partial<Record<EditableField, string>>;
  /** Admin test sends: send even when the template is switched off. */
  ignoreDisabled?: boolean;
}

export type SendStatus = "sent" | "failed" | "duplicate" | "disabled";

export interface SendResult {
  status: SendStatus;
  logId?: string;
  resendId?: string;
  error?: string;
}

/** Removes anything that could be a secret from text before it is stored or logged. */
export function scrubError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/re_[A-Za-z0-9_]{8,}/g, "[key]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 500);
}

function logEvent(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...data }));
}

// --- logo ----------------------------------------------------------------------
// Embedding the logo inline (CID) keeps it visible in clients that block remote
// images. Fetched once per function instance; falls back to the hosted URL.
let logoCache: { content: string } | null | undefined;

async function loadInlineLogo(cfg: EmailConfig): Promise<{ content: string } | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const res = await fetch(cfg.logoUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 500_000) throw new Error("logo too large to inline");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    logoCache = { content: btoa(binary) };
  } catch (e) {
    logEvent("email.logo_inline_failed", { reason: String(e) });
    logoCache = null;
  }
  return logoCache;
}

// --- template overrides ----------------------------------------------------------
export async function loadTemplateOverride(admin: SupabaseClient, key: TemplateKey) {
  const { data, error } = await admin
    .from("email_templates")
    .select(["template_key", "enabled", ...EDITABLE_FIELDS].join(", "))
    .eq("template_key", key)
    .maybeSingle();
  if (error) {
    // Never block a transactional email because overrides could not be read.
    logEvent("email.template_override_error", { template: key, error: error.message });
    return null;
  }
  return data as Record<string, unknown> | null;
}

export async function renderForSend(
  admin: SupabaseClient,
  key: TemplateKey,
  variables: Vars,
  logoSrc?: string,
  contentOverride?: Partial<Record<EditableField, string>>,
): Promise<{ enabled: boolean; rendered: RenderedEmail }> {
  const cfg = getEmailConfig();
  const override = await loadTemplateOverride(admin, key);
  const def = TEMPLATES[key];
  // deno-lint-ignore no-explicit-any
  const content = { ...effectiveContent(def, override as any), ...(contentOverride ?? {}) };
  return {
    enabled: override ? override.enabled !== false : true,
    rendered: renderEmail(def, content, variables, cfg, { logoSrc }),
  };
}

// --- Resend ----------------------------------------------------------------------
async function postToResend(
  apiKey: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
): Promise<{ id?: string; error?: string; attempts: number }> {
  let attempts = 0;
  let lastError = "Unknown error";
  for (const delay of [0, 800, 2500]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    attempts++;
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Same log row => Resend sends at most once, even across our retries.
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.id) return { id: String(body.id), attempts };
      lastError = `Resend ${res.status}: ${body?.message ?? body?.name ?? res.statusText}`;
      // Retry only rate limits and server errors.
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastError = `Network error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { error: lastError, attempts };
}

/**
 * Renders and sends one templated email. Never throws for delivery problems;
 * inspect `status`. Throws only on programming errors (unknown template).
 */
export async function sendTemplatedEmail(
  admin: SupabaseClient,
  opts: SendTemplatedEmailOptions,
): Promise<SendResult> {
  const def = TEMPLATES[opts.templateKey];
  if (!def) throw new Error(`Unknown email template: ${opts.templateKey}`);
  const cfg = getEmailConfig();
  const to = opts.to.trim();

  const inlineLogo = await loadInlineLogo(cfg);
  const { enabled, rendered } = await renderForSend(
    admin,
    opts.templateKey,
    opts.variables,
    inlineLogo ? `cid:${LOGO_CID}` : cfg.logoUrl,
    opts.contentOverride,
  );
  const subject = `${opts.subjectPrefix ?? ""}${rendered.subject}`;

  if (!enabled && !opts.ignoreDisabled) {
    await admin.from("email_logs").insert({
      template_key: opts.templateKey,
      recipient_email: to.toLowerCase(),
      recipient_user_id: opts.recipientUserId ?? null,
      subject,
      status: "skipped",
      error_message: "Notification disabled by an administrator",
      context: opts.context ?? {},
      triggered_by: opts.triggeredBy ?? null,
    });
    logEvent("email.skipped_disabled", { template: opts.templateKey, to: maskEmail(to) });
    return { status: "disabled" };
  }

  const { data: logId, error: claimError } = await admin.rpc("claim_email_send", {
    p_template_key: opts.templateKey,
    p_recipient_email: to,
    p_recipient_user_id: opts.recipientUserId ?? null,
    p_subject: subject,
    p_dedupe_key: opts.dedupeKey ?? null,
    p_window_seconds: opts.dedupeKey ? (opts.dedupeWindowSeconds === undefined ? 120 : opts.dedupeWindowSeconds) : null,
    p_context: opts.context ?? {},
    p_triggered_by: opts.triggeredBy ?? null,
    p_resent_from: opts.resentFrom ?? null,
  });
  if (claimError) {
    logEvent("email.claim_failed", { template: opts.templateKey, error: claimError.message });
    return { status: "failed", error: "Could not record the email attempt" };
  }
  if (!logId) {
    logEvent("email.duplicate_suppressed", { template: opts.templateKey, to: maskEmail(to) });
    return { status: "duplicate" };
  }

  const apiKey = (Deno.env.get("RESEND_API_KEY") ?? "").trim();
  let result: { id?: string; error?: string; attempts: number };
  if (!apiKey) {
    result = { error: "RESEND_API_KEY is not configured", attempts: 0 };
  } else {
    const payload: Record<string, unknown> = {
      from: cfg.from,
      to: [to],
      subject,
      html: rendered.html,
      text: rendered.text,
      tags: [{ name: "template", value: opts.templateKey }],
    };
    if (cfg.replyTo) payload.reply_to = cfg.replyTo;
    if (inlineLogo) {
      payload.attachments = [{
        filename: "majr-books-logo.png",
        content: inlineLogo.content,
        content_type: "image/png",
        content_id: LOGO_CID,
      }];
    }
    result = await postToResend(apiKey, String(logId), payload);
  }

  if (result.id) {
    await admin.from("email_logs").update({
      status: "sent",
      resend_id: result.id,
      attempts: result.attempts,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", logId);
    logEvent("email.sent", { template: opts.templateKey, log_id: logId, resend_id: result.id, to: maskEmail(to) });
    return { status: "sent", logId: String(logId), resendId: result.id };
  }

  const error = scrubError(result.error ?? "Unknown error");
  await admin.from("email_logs").update({
    status: "failed",
    error_message: error,
    attempts: result.attempts,
    updated_at: new Date().toISOString(),
  }).eq("id", logId);
  logEvent("email.failed", { template: opts.templateKey, log_id: logId, error, to: maskEmail(to) });
  return { status: "failed", logId: String(logId), error };
}
