import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, errorResponse, HttpError, jsonResponse, requireUser, serviceClient } from "../_shared/security.ts";
import { sendPasswordChangedEmail } from "../_shared/email/workflows.ts";

// Called by the app right after a signed-in user changes their password
// (Settings, Client Settings, or the legacy Supabase recovery link).
// The recipient is always the caller's own account email. To keep this from
// being used to spam, the account must have been updated in the last
// 10 minutes and repeats within 60 seconds are suppressed.
const RECENT_UPDATE_MS = 10 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const user = await requireUser(req);
    const updatedAt = user.updated_at ? new Date(user.updated_at).getTime() : 0;
    if (!updatedAt || Date.now() - updatedAt > RECENT_UPDATE_MS) {
      throw new HttpError(400, "No recent password change found for this account");
    }

    const result = await sendPasswordChangedEmail(serviceClient(), user, { triggeredBy: user.id });
    return jsonResponse({ success: result.status !== "failed", status: result.status });
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
