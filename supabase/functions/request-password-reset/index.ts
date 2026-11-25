import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, errorResponse, HttpError, jsonResponse, serviceClient } from "../_shared/security.ts";
import { issuePasswordReset, sha256Hex } from "../_shared/email/workflows.ts";

// Public endpoint: emails a single-use, time-limited password reset link.
//
// The response is identical whether or not the address has an account, so it
// cannot be used to discover registered emails. Requests are rate limited per
// address and per (hashed) IP address.
const WINDOW_MINUTES = 15;
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;
const GENERIC_RESPONSE = {
  success: true,
  message: "If an account exists for that email, a password reset link is on its way.",
};

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await req.json().catch(() => ({}));
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      throw new HttpError(400, "Please enter a valid email address");
    }

    const admin = serviceClient();
    const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();

    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") || "";
    const ipHash = ip ? await sha256Hex(`pwreset:${ip}`) : null;

    if (ipHash) {
      const { count } = await admin
        .from("password_reset_tokens")
        .select("id", { count: "exact", head: true })
        .eq("requested_ip_hash", ipHash)
        .gte("created_at", since);
      if ((count ?? 0) >= MAX_PER_IP) {
        throw new HttpError(429, "Too many reset requests. Please wait a few minutes and try again.");
      }
    }

    const { data: userId, error: lookupError } = await admin.rpc("find_auth_user_id_by_email", { p_email: email });
    if (lookupError) throw lookupError;
    if (!userId) return jsonResponse(GENERIC_RESPONSE);

    const { count: recent } = await admin
      .from("password_reset_tokens")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since);
    if ((recent ?? 0) >= MAX_PER_EMAIL) {
      // Same answer as success; the user already has several valid-looking emails.
      console.log(JSON.stringify({ event: "password_reset.rate_limited" }));
      return jsonResponse(GENERIC_RESPONSE);
    }

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId as string);
    if (userError || !userData?.user) return jsonResponse(GENERIC_RESPONSE);

    // Delivery failures are recorded in email_logs for admins; the response
    // stays generic so it never reveals whether the account exists.
    await issuePasswordReset(admin, userData.user, { ipHash });
    return jsonResponse(GENERIC_RESPONSE);
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
