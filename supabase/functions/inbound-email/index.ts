// Webhook for incoming email → MAJRBooks Messages inbox.
//
// Point your email provider's inbound webhook (Resend Inbound, Postmark,
// SendGrid Inbound Parse, Mailgun routes, …) at:
//   https://<project>.supabase.co/functions/v1/inbound-email?secret=<INBOUND_EMAIL_SECRET>
// or send the secret in the `x-inbound-secret` header.
//
// Accepts JSON or form data and reads the common field names:
//   from / From / sender, subject / Subject, text / TextBody / body-plain / plain
//
// If the subject contains a conversation code like [MSG-1A2B3C4D] and the
// sender is that conversation's client (or one of its staff), the email is
// added as a reply. Otherwise it opens a new conversation.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, errorResponse, HttpError, jsonResponse, serviceClient } from "../_shared/security.ts";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object" && "email" in (v as Record<string, unknown>)) {
      const o = v as Record<string, unknown>;
      return o.name ? `${o.name} <${o.email}>` : String(o.email);
    }
    if (Array.isArray(v) && v.length) return pick({ x: v[0] }, ["x"]);
  }
  return "";
}

function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: raw.trim() };
}

// Drop the quoted history under a reply so the thread stays readable.
function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: /.test(line)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const secret = Deno.env.get("INBOUND_EMAIL_SECRET");
    if (!secret) throw new HttpError(503, "Inbound email is not configured");
    const presented = req.headers.get("x-inbound-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
    if (!safeEqual(presented, secret)) throw new HttpError(401, "Unauthorized");

    let payload: Record<string, unknown> = {};
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      payload = await req.json();
      // Some providers wrap the email: { type, data: { ... } }
      if (payload.data && typeof payload.data === "object") payload = payload.data as Record<string, unknown>;
    } else {
      const form = await req.formData();
      form.forEach((v, k) => { if (typeof v === "string") payload[k] = v; });
    }

    const from = parseAddress(pick(payload, ["from", "From", "sender", "FromFull"]));
    const subject = pick(payload, ["subject", "Subject"]).slice(0, 300);
    const rawText = pick(payload, ["text", "TextBody", "body-plain", "plain", "stripped-text", "body"]);
    if (!from.email || !rawText) throw new HttpError(400, "Missing sender or text body");

    const ref = subject.match(/\[(MSG-[A-Z0-9]{8})\]/i)?.[1] ?? null;
    const body = (ref ? stripQuoted(rawText) : rawText.trim()).slice(0, 10000);
    const cleanSubject = subject.replace(/\[(MSG-[A-Z0-9]{8})\]/i, "").replace(/^\s*(re|fwd?):\s*/i, "").trim();

    const admin = serviceClient();
    const { data, error } = await admin.rpc("inbox_ingest", {
      p_name: from.name,
      p_email: from.email,
      p_subject: cleanSubject,
      p_body: body,
      p_source: "email",
      p_ref_code: ref,
    });
    if (error) throw new HttpError(400, error.message);

    const row = Array.isArray(data) ? data[0] : data;

    // Pass it on to the other side of the conversation.
    if (row?.message_id) {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-inbox-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
        body: JSON.stringify({ messageId: row.message_id }),
      }).catch((e) => console.error("notify failed", e));
    }

    return jsonResponse({ success: true, threadId: row?.thread_id ?? null });
  } catch (error) {
    return errorResponse(error);
  }
});
