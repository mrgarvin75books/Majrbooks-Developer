import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  assertUuid,
  corsHeaders,
  errorResponse,
  HttpError,
  jsonResponse,
  requireUser,
  serviceClient,
} from "../_shared/security.ts";
import { getEmailConfig } from "../_shared/email/config.ts";
import { renderEmail } from "../_shared/email/render.ts";
import { loadTemplateOverride, sendTemplatedEmail } from "../_shared/email/send.ts";
import {
  EDITABLE_FIELDS,
  type EditableField,
  effectiveContent,
  FIELD_LIMITS,
  GLOBAL_VARIABLES,
  isTemplateKey,
  type TemplateContent,
  type TemplateKey,
  TEMPLATE_KEYS,
  TEMPLATES,
} from "../_shared/email/templates.ts";
import {
  CLIENT_INVITATION_COLUMNS,
  type ClientInvitationRow,
  issuePasswordReset,
  sendClientInvitationEmail,
  sendPasswordChangedEmail,
  sendSignupConfirmationEmail,
  sendStaffInvitationEmail,
} from "../_shared/email/workflows.ts";

// Admin -> Email Notifications. Platform admins only.
//
// actions:
//   overview                      templates (+ overrides) and 30-day stats
//   preview   {templateKey, content?}          render with sample data
//   save      {templateKey, enabled?, content?} store overrides
//   reset     {templateKey}                    restore default wording
//   logs      {status?, templateKey?, search?, page?}
//   resend    {logId}                          retry a failed/skipped email
//   test      {templateKey, content?}          send a sample to yourself

type Admin = ReturnType<typeof serviceClient>;

async function requireAdmin(req: Request) {
  const user = await requireUser(req);
  const admin = serviceClient();
  const { data } = await admin
    .from("app_user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new HttpError(403, "Administrator access required");
  return { user, admin };
}

function templateKeyFrom(value: unknown): TemplateKey {
  if (!isTemplateKey(value)) throw new HttpError(400, "Unknown email template");
  return value;
}

/** Validates admin-supplied content and returns only the known fields. */
function cleanContent(value: unknown): Partial<Record<EditableField, string>> {
  if (value == null) return {};
  if (typeof value !== "object") throw new HttpError(400, "content must be an object");
  const out: Partial<Record<EditableField, string>> = {};
  for (const field of EDITABLE_FIELDS) {
    const v = (value as Record<string, unknown>)[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
    if (v.length > FIELD_LIMITS[field]) throw new HttpError(400, `${field} is too long (max ${FIELD_LIMITS[field]})`);
    if (/<\s*\/?\s*[a-z!]/i.test(v)) throw new HttpError(400, `${field} cannot contain HTML. Use the formatting shown in the editor.`);
    out[field] = v;
  }
  for (const required of ["subject", "heading", "body", "cta_label"] as const) {
    if (out[required] !== undefined && !out[required]!.trim()) {
      throw new HttpError(400, `${required.replace("_", " ")} cannot be empty`);
    }
  }
  return out;
}

async function contentFor(admin: Admin, key: TemplateKey, draft?: Partial<Record<EditableField, string>>) {
  const override = await loadTemplateOverride(admin, key);
  // deno-lint-ignore no-explicit-any
  const base = effectiveContent(TEMPLATES[key], override as any);
  return { content: { ...base, ...(draft ?? {}) } as TemplateContent, override };
}

async function overview(admin: Admin) {
  const { data: overrides } = await admin.from("email_templates").select("*");
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: recent } = await admin
    .from("email_logs")
    .select("template_key, status")
    .gte("created_at", since)
    .limit(10000);

  const stats: Record<string, { sent: number; failed: number; skipped: number; pending: number }> = {};
  const totals = { sent: 0, failed: 0, skipped: 0, pending: 0 };
  for (const r of recent ?? []) {
    const s = (stats[r.template_key] ??= { sent: 0, failed: 0, skipped: 0, pending: 0 });
    const k = r.status as keyof typeof totals;
    if (k in totals) {
      s[k]++;
      totals[k]++;
    }
  }

  const templates = TEMPLATE_KEYS.map((key) => {
    const def = TEMPLATES[key];
    const override = (overrides ?? []).find((o) => o.template_key === key) ?? null;
    const customized = !!override && EDITABLE_FIELDS.some((f) => override[f] != null);
    return {
      key,
      name: def.name,
      description: def.description,
      audience: def.audience,
      trigger: def.trigger,
      resendable: def.resendable,
      variables: [...def.variables, ...GLOBAL_VARIABLES],
      enabled: override ? override.enabled !== false : true,
      customized,
      updated_at: override?.updated_at ?? null,
      defaults: def.defaults,
      content: effectiveContent(def, override),
      stats: stats[key] ?? { sent: 0, failed: 0, skipped: 0, pending: 0 },
    };
  });

  return { templates, totals, config: { from: getEmailConfig().from, appUrl: getEmailConfig().appUrl } };
}

async function save(admin: Admin, userId: string, body: Record<string, unknown>) {
  const key = templateKeyFrom(body.templateKey);
  const draft = cleanContent(body.content);
  const def = TEMPLATES[key];

  const row: Record<string, unknown> = { template_key: key, updated_by: userId, updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") row.enabled = body.enabled;
  for (const field of EDITABLE_FIELDS) {
    if (draft[field] === undefined) continue;
    // Store only real changes so future improvements to defaults still apply.
    row[field] = draft[field] === def.defaults[field] ? null : draft[field];
  }

  const { error } = await admin.from("email_templates").upsert(row, { onConflict: "template_key" });
  if (error) throw error;

  await admin.from("audit_logs").insert({
    owner_id: userId,
    user_id: userId,
    action: typeof body.enabled === "boolean" && !body.content
      ? (body.enabled ? "email_template_enabled" : "email_template_disabled")
      : "email_template_updated",
    entity_type: "email_template",
    details: { template_key: key, fields: Object.keys(draft) },
  });
  return { success: true };
}

async function reset(admin: Admin, userId: string, key: TemplateKey) {
  const nulls = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, null]));
  const { error } = await admin
    .from("email_templates")
    .upsert({ template_key: key, ...nulls, updated_by: userId, updated_at: new Date().toISOString() }, {
      onConflict: "template_key",
    });
  if (error) throw error;
  await admin.from("audit_logs").insert({
    owner_id: userId,
    user_id: userId,
    action: "email_template_reset",
    entity_type: "email_template",
    details: { template_key: key },
  });
  return { success: true };
}

async function logs(admin: Admin, body: Record<string, unknown>) {
  const pageSize = 25;
  const page = Math.max(0, Math.min(1000, Number(body.page) || 0));
  let q = admin
    .from("email_logs")
    .select(
      "id, template_key, recipient_email, subject, status, resend_id, error_message, attempts, created_at, sent_at, resent_from, superseded_by",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (typeof body.status === "string" && ["sent", "failed", "skipped", "pending"].includes(body.status)) {
    q = q.eq("status", body.status);
  }
  if (isTemplateKey(body.templateKey)) q = q.eq("template_key", body.templateKey);
  if (typeof body.search === "string" && body.search.trim()) {
    q = q.ilike("recipient_email", `%${body.search.trim().replace(/[%_,()]/g, "").slice(0, 100)}%`);
  }
  const { data, count, error } = await q;
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0, page, pageSize };
}

async function resend(admin: Admin, userId: string, logId: string) {
  const { data: log, error } = await admin
    .from("email_logs")
    .select("id, template_key, status, context, superseded_by")
    .eq("id", logId)
    .maybeSingle();
  if (error) throw error;
  if (!log) throw new HttpError(404, "Email log not found");
  if (log.status === "sent") throw new HttpError(409, "This email was delivered to Resend successfully");
  if (log.superseded_by) throw new HttpError(409, "This email has already been resent");
  if (!isTemplateKey(log.template_key)) throw new HttpError(400, "Unknown template");

  const ctx = (log.context ?? {}) as Record<string, string>;
  const opts = { triggeredBy: userId, resentFrom: log.id, forceNew: true };
  const getUser = async () => {
    const { data } = await admin.auth.admin.getUserById(assertUuid(ctx.user_id, "user_id"));
    if (!data?.user) throw new HttpError(404, "The account for this email no longer exists");
    return data.user;
  };

  let result;
  switch (log.template_key as TemplateKey) {
    case "client_invitation": {
      const { data: inv } = await admin
        .from("client_invitations")
        .select(CLIENT_INVITATION_COLUMNS)
        .eq("id", assertUuid(ctx.invitation_id, "invitation_id"))
        .maybeSingle();
      if (!inv) throw new HttpError(404, "The invitation no longer exists");
      if ((inv as ClientInvitationRow).status === "accepted") throw new HttpError(409, "The client has already accepted");
      // A fresh token and expiry: the original link may be stale.
      result = await sendClientInvitationEmail(admin, inv as ClientInvitationRow, { ...opts, rotate: true });
      break;
    }
    case "staff_invitation":
      try {
        result = await sendStaffInvitationEmail(admin, assertUuid(ctx.team_member_id, "team_member_id"), opts);
      } catch (e) {
        throw new HttpError(409, e instanceof Error ? e.message : "Cannot resend this invitation");
      }
      break;
    case "signup_client":
    case "signup_staff":
    case "signup_owner":
      result = await sendSignupConfirmationEmail(admin, await getUser(), opts);
      break;
    case "password_reset":
      // Never re-send an old link: issue a new single-use token.
      result = await issuePasswordReset(admin, await getUser(), opts);
      break;
    case "password_changed":
      result = await sendPasswordChangedEmail(admin, await getUser(), opts);
      break;
  }

  await admin.from("audit_logs").insert({
    owner_id: userId,
    user_id: userId,
    action: "email_resent",
    entity_type: "email_log",
    entity_id: log.id,
    details: { template_key: log.template_key, result: result?.status },
  });
  if (result?.status === "disabled") throw new HttpError(409, "This notification is turned off. Enable it first.");
  return { success: result?.status === "sent", status: result?.status, error: result?.error };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user, admin } = await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cfg = getEmailConfig();

    switch (body.action) {
      case "overview":
        return jsonResponse(await overview(admin));

      case "preview": {
        const key = templateKeyFrom(body.templateKey);
        const { content } = await contentFor(admin, key, cleanContent(body.content));
        const rendered = renderEmail(TEMPLATES[key], content, TEMPLATES[key].sample, cfg, { logoSrc: cfg.logoUrl });
        return jsonResponse(rendered);
      }

      case "save":
        return jsonResponse(await save(admin, user.id, body));

      case "reset":
        return jsonResponse(await reset(admin, user.id, templateKeyFrom(body.templateKey)));

      case "logs":
        return jsonResponse(await logs(admin, body));

      case "resend":
        return jsonResponse(await resend(admin, user.id, assertUuid(body.logId, "logId")));

      case "test": {
        const key = templateKeyFrom(body.templateKey);
        if (!user.email) throw new HttpError(400, "Your account has no email address");
        // Test sends use the saved (or draft) wording with sample data. They
        // ignore the on/off switch so a disabled template can still be checked.
        const draft = cleanContent(body.content);
        const result = await sendTemplatedEmail(admin, {
          templateKey: key,
          to: user.email,
          recipientUserId: user.id,
          variables: TEMPLATES[key].sample,
          triggeredBy: user.id,
          subjectPrefix: "[Test] ",
          context: { test: true },
          contentOverride: Object.keys(draft).length ? draft : undefined,
          ignoreDisabled: true,
        });
        return jsonResponse({ success: result.status === "sent", status: result.status, error: result.error, to: user.email });
      }

      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
