import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  corsHeaders,
  errorResponse,
  escapeHtml,
  getAuthUser,
  HttpError,
  jsonResponse,
  serviceClient,
} from "../_shared/security.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: "MajrBooks <support@majrbooks.com>", to: [to], subject, html }),
  });
  if (!res.ok) console.error("Resend error:", res.status, await res.text());
}

// Sends (a) an internal activity notice to support@majrbooks.com and
// (b) on signup, a one-time welcome email to the new user.
//
// The recipient is never taken from the request body:
//  - login:  the caller must be signed in; their own account email is used.
//  - signup: the caller passes the new user's id (there may be no session yet
//            when email confirmation is on). The account must have been
//            created in the last 15 minutes, and the welcome email is sent at
//            most once per account (tracked in app_metadata).
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const body = await req.json().catch(() => ({}));
    const eventType = body?.eventType === "signup" ? "signup" : "login";
    const admin = serviceClient();

    let user;
    if (eventType === "login") {
      user = await getAuthUser(req);
      if (!user) throw new HttpError(401, "Authentication required");
    } else {
      const sessionUser = await getAuthUser(req);
      if (sessionUser) {
        user = sessionUser;
      } else {
        if (typeof body?.userId !== "string") throw new HttpError(400, "userId is required");
        const { data, error } = await admin.auth.admin.getUserById(body.userId);
        if (error || !data?.user) throw new HttpError(404, "User not found");
        user = data.user;
      }
      const createdAt = new Date(user.created_at).getTime();
      if (!createdAt || Date.now() - createdAt > SIGNUP_WINDOW_MS) {
        throw new HttpError(400, "Signup notification window has expired");
      }
      if (user.app_metadata?.welcome_email_sent) {
        return jsonResponse({ success: true, message: "Already sent" });
      }
    }

    const email = user.email ?? "";
    if (!email) throw new HttpError(400, "Account has no email address");

    const displayName = escapeHtml(user.user_metadata?.full_name || email);
    const safeEmail = escapeHtml(email);
    const userAgent = typeof body?.userAgent === "string" ? escapeHtml(body.userAgent.slice(0, 300)) : "";
    const eventTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const subjectName = String(user.user_metadata?.full_name || email).replace(/[\r\n]/g, " ").slice(0, 120);

    await sendEmail(
      "support@majrbooks.com",
      eventType === "signup" ? `New User Signup - ${subjectName}` : `Login Activity - ${subjectName}`,
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a365d;">${eventType === "signup" ? "New User Registration" : "Login Activity"}</h2>
          <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>User:</strong> ${displayName}</p>
            <p><strong>Email:</strong> ${safeEmail}</p>
            <p><strong>Event:</strong> ${eventType === "signup" ? "New Account Created" : "User Logged In"}</p>
            <p><strong>Time:</strong> ${eventTime} ET</p>
            ${userAgent ? `<p><strong>Device:</strong> ${userAgent}</p>` : ""}
          </div>
          <p style="color: #718096; font-size: 12px;">This is an automated notification from MajrBooks.</p>
        </div>
      `,
    );

    // Welcome email: only for self-signups that actually received a trial
    // (invited clients and team members don't get a trial).
    const meta = user.user_metadata ?? {};
    if (eventType === "signup" && !meta.is_client && !meta.is_team_member) {
      await sendEmail(
        email,
        "Welcome to MajrBooks - Your 14-Day Free Trial Has Started!",
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #00C896;">Welcome to MajrBooks!</h1>
            <p>Hi ${displayName},</p>
            <p>Thank you for signing up! Your <strong>14-day free trial</strong> has started.</p>
            <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #00C896;">
              <h3 style="margin-top: 0;">During your trial, you get full access to:</h3>
              <ul>
                <li>Complete bookkeeping and invoicing</li>
                <li>Payroll management</li>
                <li>Tax preparation tools</li>
                <li>AI-powered tax assistance</li>
                <li>And much more!</li>
              </ul>
            </div>
            <p>After your trial ends, you can choose a plan that fits your needs.</p>
            <p>If you have any questions, feel free to reach out to us at support@majrbooks.com</p>
            <p>Best regards,<br>The MajrBooks Team</p>
          </div>
        `,
      );
    }

    if (eventType === "signup") {
      await admin.auth.admin.updateUserById(user.id, {
        app_metadata: { ...(user.app_metadata ?? {}), welcome_email_sent: true },
      });
    }

    return jsonResponse({ success: true, message: "Notification sent successfully" });
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
