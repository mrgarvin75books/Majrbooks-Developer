// Emails the other side of an inbox conversation about a new message.
//
//   * requester (client / visitor) wrote  → firm owner + active team members
//     (or MAJRBooks support for threads with no firm)
//   * staff wrote                        → the requester
//
// Body: { messageId }. Each message is emailed at most once (notified_at), so
// calling this twice — or by anyone — can't be used to send repeat emails.
// Signed-in callers must be able to see the thread; logged-out callers can
// only trigger the notice for a message created by a visitor in the last
// 10 minutes.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import {
  assertUuid,
  corsHeaders,
  errorResponse,
  escapeHtml,
  getAuthUser,
  HttpError,
  isInternalRequest,
  jsonResponse,
  serviceClient,
} from "../_shared/security.ts";

const FROM = Deno.env.get("INBOX_FROM_EMAIL") || "MAJRBooks Messages <support@majrbooks.com>";
const SUPPORT_INBOX = Deno.env.get("SUPPORT_INBOX_EMAIL") || "support@prm3tax.com";
// Address that receives email replies (see inbound-email). Optional.
const REPLY_TO = Deno.env.get("INBOUND_EMAIL_ADDRESS") || undefined;
const APP_URL = Deno.env.get("APP_URL") || "https://majrbooks.com";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) throw new Error("RESEND_API_KEY is not configured");

    const body = await req.json().catch(() => ({}));
    const messageId = assertUuid(body?.messageId, "messageId");

    const admin = serviceClient();
    const internal = isInternalRequest(req);
    const caller = internal ? null : await getAuthUser(req);

    const { data: message, error: msgError } = await admin
      .from("inbox_messages")
      .select("id, thread_id, author_id, author_type, author_name, body, notified_at, created_at")
      .eq("id", messageId)
      .maybeSingle();
    if (msgError) throw msgError;
    if (!message) throw new HttpError(404, "Message not found");
    if (message.notified_at) return jsonResponse({ success: true, skipped: "already notified" });

    // Who may trigger it
    if (internal) {
      // inbound-email and other server code
    } else if (caller) {
      if (message.author_id !== caller.id) throw new HttpError(404, "Message not found");
    } else {
      const ageMs = Date.now() - new Date(message.created_at).getTime();
      if (message.author_id || message.author_type !== "requester" || ageMs > 10 * 60 * 1000) {
        throw new HttpError(404, "Message not found");
      }
    }

    // Claim the message first so concurrent calls send only one email.
    const { data: claimed } = await admin
      .from("inbox_messages")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", messageId)
      .is("notified_at", null)
      .select("id");
    if (!claimed || claimed.length === 0) return jsonResponse({ success: true, skipped: "already notified" });

    const { data: thread, error: threadError } = await admin
      .from("inbox_threads")
      .select("id, ref_code, firm_owner_id, requester_id, requester_name, requester_email, subject")
      .eq("id", message.thread_id)
      .single();
    if (threadError) throw threadError;

    let recipients: string[] = [];
    let link: string | null;
    if (message.author_type === "requester") {
      link = `${APP_URL}/messages?thread=${thread.id}`;
      if (thread.firm_owner_id) {
        const { data: owner } = await admin.auth.admin.getUserById(thread.firm_owner_id);
        if (owner?.user?.email) recipients.push(owner.user.email);
        const { data: team } = await admin
          .from("team_members")
          .select("email, user_id")
          .eq("owner_id", thread.firm_owner_id)
          .eq("is_active", true)
          .not("user_id", "is", null);
        for (const t of team ?? []) if (t.email) recipients.push(t.email);
      } else {
        recipients.push(SUPPORT_INBOX);
      }
    } else {
      // Visitors without an account answer by email instead.
      link = thread.requester_id ? `${APP_URL}/auth` : null;
      recipients.push(thread.requester_email);
    }
    recipients = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (recipients.length === 0) return jsonResponse({ success: true, skipped: "no recipients" });

    const fromStaff = message.author_type !== "requester";
    const heading = fromStaff
      ? `${escapeHtml(message.author_name)} replied to your message`
      : `New message from ${escapeHtml(thread.requester_name)} (${escapeHtml(thread.requester_email)})`;
    const subject = `${fromStaff ? "Re: " : ""}${thread.subject} [${thread.ref_code}]`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
        <h2 style="color: #2e7d32; margin-bottom: 4px;">${heading}</h2>
        <p style="color: #6b7280; margin-top: 0;">${escapeHtml(thread.subject)} · ${escapeHtml(thread.ref_code)}</p>
        <div style="background: #f3f4f6; padding: 16px 20px; border-radius: 8px; white-space: pre-wrap; line-height: 1.5;">${escapeHtml(message.body)}</div>
        ${link ? `<p style="margin: 24px 0;">
          <a href="${escapeHtml(link)}" style="background: #2e7d32; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
            ${fromStaff ? "View the conversation" : "Open in MAJRBooks Messages"}
          </a>
        </p>` : ""}
        ${REPLY_TO ? `<p style="color: #6b7280; font-size: 12px;">You can also reply to this email — keep ${escapeHtml(thread.ref_code)} in the subject.</p>` : ""}
      </div>`;

    // Each recipient gets their own email so addresses aren't shared.
    // Resend reports failures in `error` instead of throwing, so check each result.
    const resend = new Resend(resendApiKey);
    const failures: string[] = [];
    for (const to of recipients) {
      const { error: sendError } = await resend.emails.send({
        from: FROM,
        to: [to],
        subject,
        html,
        ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      });
      if (sendError) {
        console.error(`[notify-inbox-message] email to ${to} failed:`, JSON.stringify(sendError));
        failures.push(sendError.message ?? String(sendError));
      }
    }

    if (failures.length === recipients.length) {
      // Nothing went out: release the claim so the notice can be sent again.
      await admin.from("inbox_messages").update({ notified_at: null }).eq("id", messageId);
      throw new HttpError(502, `Email could not be sent: ${failures[0]}`);
    }

    console.log(`[notify-inbox-message] sent ${recipients.length - failures.length}/${recipients.length} for ${messageId}`);
    return jsonResponse({ success: true, sent: recipients.length - failures.length });
  } catch (error) {
    return errorResponse(error);
  }
});
