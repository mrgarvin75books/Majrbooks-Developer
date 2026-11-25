import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  corsHeaders,
  errorResponse,
  getScopeOwnerId,
  HttpError,
  jsonResponse,
  requireUser,
  serviceClient,
} from "../_shared/security.ts";
import {
  CLIENT_INVITATION_COLUMNS,
  type ClientInvitationRow,
  sendClientInvitationEmail,
} from "../_shared/email/workflows.ts";

// Sends the "You're Invited! Access Your Client Portal" email.
//
// The caller must be signed in, and the invitation must belong to the books
// they work in. Every value in the email is read from the database.
//   { inviteToken }  send the invitation that was just created
//   { clientEmail }  resend (e.g. from the client list): the token is rotated
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const caller = await requireUser(req);
    const supabase = serviceClient();
    const ownerId = await getScopeOwnerId(supabase, caller.id);
    const body = await req.json().catch(() => ({}));

    let invitation: ClientInvitationRow | null = null;
    let rotate = false;

    if (typeof body?.inviteToken === "string" && body.inviteToken) {
      const { data, error } = await supabase
        .from("client_invitations")
        .select(CLIENT_INVITATION_COLUMNS)
        .eq("invite_token", body.inviteToken)
        .in("user_id", [caller.id, ownerId])
        .maybeSingle();
      if (error) throw error;
      invitation = data as ClientInvitationRow | null;
    } else if (typeof body?.clientEmail === "string" && body.clientEmail) {
      const { data, error } = await supabase
        .from("client_invitations")
        .select(CLIENT_INVITATION_COLUMNS)
        .ilike("client_email", body.clientEmail.trim())
        .in("user_id", [caller.id, ownerId])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      invitation = data as ClientInvitationRow | null;
      rotate = true;
    }

    if (!invitation || !invitation.invite_token) {
      throw new HttpError(
        404,
        "No pending invitation was found for this client. Send a new invitation from Client Invitations.",
      );
    }
    if (invitation.status === "accepted") {
      throw new HttpError(409, "This client has already accepted their invitation");
    }

    const result = await sendClientInvitationEmail(supabase, invitation, { rotate, triggeredBy: caller.id });

    if (result.status === "failed") {
      throw new HttpError(502, "The invitation was saved, but the email could not be sent. Please try again.");
    }
    if (result.status === "disabled") {
      return jsonResponse({ success: true, emailed: false, message: "Client invitation emails are turned off by an administrator" });
    }
    return jsonResponse({
      success: true,
      emailed: result.status === "sent",
      duplicate: result.status === "duplicate",
      message: result.status === "duplicate" ? "Invitation was already sent" : "Invitation email sent successfully",
      emailId: result.resendId,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
});
