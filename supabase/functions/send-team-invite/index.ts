import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  assertUuid,
  corsHeaders,
  errorResponse,
  HttpError,
  jsonResponse,
  requireUser,
  serviceClient,
} from "../_shared/security.ts";
import { sendStaffInvitationEmail } from "../_shared/email/workflows.ts";

// Sends the "Welcome to the Team! Your Account Invitation Is Ready" email.
// The caller must be signed in and must own the team seat being invited.
// Every value in the email comes from the database, never from the request body.
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const caller = await requireUser(req);
    const supabase = serviceClient();

    const body = await req.json().catch(() => ({}));
    const teamMemberId = assertUuid(body?.teamMemberId, "teamMemberId");

    const { data: member, error: memberError } = await supabase
      .from("team_members")
      .select("id, owner_id, user_id")
      .eq("id", teamMemberId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member || member.owner_id !== caller.id) {
      throw new HttpError(404, "Team member not found");
    }
    if (member.user_id) {
      throw new HttpError(409, "This team member has already accepted their invitation");
    }

    const result = await sendStaffInvitationEmail(supabase, member.id, { triggeredBy: caller.id });

    if (result.status === "failed") {
      throw new HttpError(502, "The team member was saved, but the invitation email could not be sent. Please try again.");
    }
    if (result.status === "disabled") {
      return jsonResponse({ success: true, emailed: false, message: "Staff invitation emails are turned off by an administrator" });
    }
    return jsonResponse({
      success: true,
      emailed: result.status === "sent",
      duplicate: result.status === "duplicate",
      message: result.status === "duplicate" ? "An invitation was just sent — please wait a minute before resending" : "Invitation sent successfully",
      emailId: result.resendId,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
