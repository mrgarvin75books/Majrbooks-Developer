import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, errorResponse, HttpError, jsonResponse, serviceClient } from "../_shared/security.ts";
import { sendPasswordChangedEmail, sha256Hex } from "../_shared/email/workflows.ts";

// Public endpoint used by /reset-password.
//   { token, validateOnly: true }  -> { valid, email_hint }   (does not use the token)
//   { token, password }            -> sets the new password
//
// Tokens are single use: the row is claimed (used_at set) atomically before the
// password changes. On success every session for the account is signed out,
// other outstanding reset links are revoked, the email address is marked
// confirmed (the user just proved they control it) and a "password changed"
// email is sent.
const MIN_LENGTH = 8;
const MAX_LENGTH = 72; // bcrypt limit

const INVALID = "This password reset link is invalid or has expired. Please request a new one.";

function hint(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 200) throw new HttpError(400, INVALID);

    const admin = serviceClient();
    const tokenHash = await sha256Hex(token);
    const nowIso = new Date().toISOString();

    const { data: row, error } = await admin
      .from("password_reset_tokens")
      .select("id, user_id, expires_at, used_at, revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (error) throw error;
    if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      return jsonResponse({ valid: false, error: INVALID }, body?.validateOnly ? 200 : 400);
    }

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(row.user_id);
    if (userError || !userData?.user) return jsonResponse({ valid: false, error: INVALID }, 400);
    const user = userData.user;

    if (body?.validateOnly) {
      return jsonResponse({ valid: true, email_hint: user.email ? hint(user.email) : null });
    }

    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < MIN_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_LENGTH} characters.`);
    }
    if (password.length > MAX_LENGTH) {
      throw new HttpError(400, `Password must be at most ${MAX_LENGTH} characters.`);
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new HttpError(400, "Password must include at least one letter and one number.");
    }

    // Claim the token. Only one concurrent request can win.
    const { data: claimed, error: claimError } = await admin
      .from("password_reset_tokens")
      .update({ used_at: nowIso })
      .eq("id", row.id)
      .is("used_at", null)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .select("id");
    if (claimError) throw claimError;
    if (!claimed || claimed.length !== 1) throw new HttpError(400, INVALID);

    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
    });
    if (updateError) {
      // Give the token back so the user can try a password the auth server accepts.
      await admin.from("password_reset_tokens").update({ used_at: null }).eq("id", row.id);
      throw new HttpError(400, updateError.message || "That password could not be used. Please choose another.");
    }

    await admin
      .from("password_reset_tokens")
      .update({ revoked_at: nowIso })
      .eq("user_id", user.id)
      .is("used_at", null)
      .is("revoked_at", null);

    const { error: revokeError } = await admin.rpc("revoke_user_sessions", { p_user_id: user.id });
    if (revokeError) console.error("Could not revoke sessions after reset:", revokeError.message);

    await sendPasswordChangedEmail(admin, user);

    return jsonResponse({ success: true, email: user.email });
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
