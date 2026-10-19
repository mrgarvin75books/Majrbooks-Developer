-- The team-invite email (send-team-invite edge function) links to /accept-invite?token=...
-- but no frontend route or backend function existed to consume that token, so invited
-- staff/employees hit a dead end (404) instead of being able to create their account.
-- This adds the RPCs the new AcceptInvite page needs, mirroring the existing
-- validate_client_invitation / mark_invitation_used pattern used for client invites.

CREATE OR REPLACE FUNCTION public.validate_team_invite(p_token TEXT)
RETURNS TABLE (
    team_member_id UUID,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    role permission_level,
    owner_id UUID,
    inviter_business_name TEXT,
    is_valid BOOLEAN,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_member RECORD;
    v_owner_business_name TEXT;
BEGIN
    SELECT * INTO v_member
    FROM team_members tm
    WHERE tm.invite_token = p_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT
            NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::permission_level, NULL::UUID, NULL::TEXT,
            FALSE, 'Invalid invitation link. Please request a new invitation.'::TEXT;
        RETURN;
    END IF;

    IF v_member.invite_accepted_at IS NOT NULL THEN
        RETURN QUERY SELECT
            v_member.id, v_member.first_name, v_member.last_name, v_member.email, v_member.role, v_member.owner_id, NULL::TEXT,
            FALSE, 'This invitation has already been used. Please contact your administrator.'::TEXT;
        RETURN;
    END IF;

    IF v_member.invite_sent_at IS NULL OR v_member.invite_sent_at < (now() - interval '7 days') THEN
        RETURN QUERY SELECT
            v_member.id, v_member.first_name, v_member.last_name, v_member.email, v_member.role, v_member.owner_id, NULL::TEXT,
            FALSE, 'This invitation has expired. Please request a new invitation.'::TEXT;
        RETURN;
    END IF;

    SELECT p.business_name INTO v_owner_business_name
    FROM profiles p
    WHERE p.id = v_member.owner_id;

    RETURN QUERY SELECT
        v_member.id, v_member.first_name, v_member.last_name, v_member.email, v_member.role, v_member.owner_id,
        COALESCE(v_owner_business_name, 'MAJR Books'),
        TRUE, NULL::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_team_invite(p_token TEXT, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE team_members
    SET
        user_id = p_user_id,
        invite_accepted_at = now(),
        is_active = true,
        updated_at = now()
    WHERE invite_token = p_token
    AND invite_accepted_at IS NULL
    AND invite_sent_at > (now() - interval '7 days');

    RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_team_invite(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_team_invite(TEXT, UUID) TO anon, authenticated;
