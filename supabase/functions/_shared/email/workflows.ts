// Business workflows that send transactional email. Each one reads every value
// it puts in an email from the database (never from the request body), and is
// shared by the user-facing edge functions and the admin "resend" action.

import type { SupabaseClient, User } from "https://esm.sh/@supabase/supabase-js@2";
import { firstNameFrom, formatDateTime, getEmailConfig } from "./config.ts";
import { type SendResult, sendTemplatedEmail } from "./send.ts";
import { describeRole, type TemplateKey } from "./templates.ts";

export interface WorkflowOptions {
  triggeredBy?: string | null;
  resentFrom?: string | null;
  /** Bypass "already sent" suppression (admin resend). */
  forceNew?: boolean;
}

const INVITE_TTL_DAYS = 7;
const INVITE_RESEND_COOLDOWN_SECONDS = 60;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 256-bit URL-safe random token. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sentRecently(admin: SupabaseClient, dedupeKey: string, seconds: number): Promise<boolean> {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const { data } = await admin
    .from("email_logs")
    .select("id")
    .eq("dedupe_key", dedupeKey)
    .in("status", ["sent", "pending"])
    .gte("created_at", since)
    .limit(1);
  return !!data && data.length > 0;
}

// =============================================================================
// Client invitation
// =============================================================================
export interface ClientInvitationRow {
  id: string;
  client_name: string | null;
  client_email: string;
  message: string | null;
  invite_token: string | null;
  inviter_business_name: string | null;
  expires_at: string | null;
  status: string;
  user_id?: string;
}

export const CLIENT_INVITATION_COLUMNS =
  "id, user_id, client_name, client_email, message, invite_token, inviter_business_name, expires_at, status";

/** Issues a fresh token (old links stop working) and a new 7-day expiry. */
export async function rotateClientInvitation(admin: SupabaseClient, invitation: ClientInvitationRow) {
  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();
  const { error } = await admin
    .from("client_invitations")
    .update({
      invite_token: token,
      expires_at: expires,
      sent_at: new Date().toISOString(),
      status: "pending",
      used_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invitation.id);
  if (error) throw error;
  invitation.invite_token = token;
  invitation.expires_at = expires;
  invitation.status = "pending";
}

export async function sendClientInvitationEmail(
  admin: SupabaseClient,
  invitation: ClientInvitationRow,
  opts: WorkflowOptions & { rotate?: boolean } = {},
): Promise<SendResult> {
  const cooldownKey = `client_invitation:${invitation.id}`;
  if (opts.rotate) {
    // Don't rotate the token (killing the link just emailed) on a double click.
    if (!opts.forceNew && await sentRecently(admin, `${cooldownKey}:rotated`, INVITE_RESEND_COOLDOWN_SECONDS)) {
      return { status: "duplicate" };
    }
    await rotateClientInvitation(admin, invitation);
  }
  if (!invitation.invite_token) throw new Error("Invitation has no token");

  const cfg = getEmailConfig();
  const expires = invitation.expires_at ? new Date(invitation.expires_at) : new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
  const tokenHash = (await sha256Hex(invitation.invite_token)).slice(0, 16);

  return await sendTemplatedEmail(admin, {
    templateKey: "client_invitation",
    to: invitation.client_email,
    variables: {
      first_name: firstNameFrom(invitation.client_name, invitation.client_email),
      client_name: invitation.client_name ?? "",
      email: invitation.client_email,
      company_name: invitation.inviter_business_name || cfg.brandName,
      personal_message: invitation.message ? String(invitation.message).slice(0, 2000) : "",
      invitation_link: `${cfg.appUrl}/accept-client-invite?token=${encodeURIComponent(invitation.invite_token)}`,
      expiration_date: formatDateTime(expires),
    },
    // Same token => same email; never send it twice.
    dedupeKey: opts.rotate ? `${cooldownKey}:rotated` : `${cooldownKey}:${tokenHash}`,
    dedupeWindowSeconds: opts.rotate ? INVITE_RESEND_COOLDOWN_SECONDS : null,
    context: { invitation_id: invitation.id },
    triggeredBy: opts.triggeredBy,
    resentFrom: opts.resentFrom,
  });
}

// =============================================================================
// Staff invitation
// =============================================================================
export async function sendStaffInvitationEmail(
  admin: SupabaseClient,
  teamMemberId: string,
  opts: WorkflowOptions = {},
): Promise<SendResult> {
  const { data: member, error } = await admin
    .from("team_members")
    .select("id, owner_id, user_id, email, first_name, last_name, role")
    .eq("id", teamMemberId)
    .maybeSingle();
  if (error) throw error;
  if (!member) throw new Error("Team member not found");
  if (member.user_id) throw new Error("This team member has already accepted their invitation");

  const dedupeKey = `staff_invitation:${member.id}`;
  if (!opts.forceNew && await sentRecently(admin, dedupeKey, INVITE_RESEND_COOLDOWN_SECONDS)) {
    return { status: "duplicate" };
  }

  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("business_name, full_name")
    .eq("id", member.owner_id)
    .maybeSingle();

  // A new token on every send; validate_team_invite expires it 7 days after invite_sent_at.
  const token = crypto.randomUUID();
  const sentAt = new Date();
  const { error: updateError } = await admin
    .from("team_members")
    .update({ invite_token: token, invite_sent_at: sentAt.toISOString() })
    .eq("id", member.id)
    .is("user_id", null);
  if (updateError) throw updateError;

  const cfg = getEmailConfig();
  const role = describeRole(member.role);
  const companyName = ownerProfile?.business_name || ownerProfile?.full_name || cfg.brandName;

  const result = await sendTemplatedEmail(admin, {
    templateKey: "staff_invitation",
    to: member.email,
    recipientUserId: null,
    variables: {
      first_name: member.first_name || firstNameFrom(null, member.email),
      last_name: member.last_name ?? "",
      full_name: `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim(),
      email: member.email,
      company_name: companyName,
      inviter_name: ownerProfile?.full_name ?? companyName,
      role: role.label,
      role_description: role.description,
      invitation_link: `${cfg.appUrl}/accept-invite?token=${encodeURIComponent(token)}`,
      expiration_date: formatDateTime(new Date(sentAt.getTime() + INVITE_TTL_DAYS * 86400_000)),
    },
    dedupeKey,
    dedupeWindowSeconds: INVITE_RESEND_COOLDOWN_SECONDS,
    context: { team_member_id: member.id, owner_id: member.owner_id },
    triggeredBy: opts.triggeredBy,
    resentFrom: opts.resentFrom,
  });

  if (result.status === "sent") {
    await admin.from("audit_logs").insert({
      owner_id: member.owner_id,
      user_id: opts.triggeredBy ?? member.owner_id,
      team_member_id: member.id,
      action: "invite_sent",
      entity_type: "team_member",
      entity_id: member.id,
      details: { role: member.role, email_log_id: result.logId },
    });
  }
  return result;
}

// =============================================================================
// Account created (signup confirmation)
// =============================================================================
export async function signupVariant(
  admin: SupabaseClient,
  userId: string,
): Promise<{ key: TemplateKey; companyName: string | null; role: string | null }> {
  const [{ data: roles }, { data: member }] = await Promise.all([
    admin.from("app_user_roles").select("role").eq("user_id", userId),
    admin.from("team_members").select("role, owner_id").eq("user_id", userId).limit(1).maybeSingle(),
  ]);
  const roleSet = new Set((roles ?? []).map((r: { role: string }) => r.role));

  if (roleSet.has("client")) {
    const { data: inv } = await admin
      .from("client_invitations")
      .select("inviter_business_name")
      .eq("client_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { key: "signup_client", companyName: inv?.inviter_business_name ?? null, role: null };
  }
  if (member) {
    const { data: owner } = await admin
      .from("profiles")
      .select("business_name, full_name")
      .eq("id", member.owner_id)
      .maybeSingle();
    return {
      key: "signup_staff",
      companyName: owner?.business_name || owner?.full_name || null,
      role: describeRole(member.role).label,
    };
  }
  return { key: "signup_owner", companyName: null, role: null };
}

export async function sendSignupConfirmationEmail(
  admin: SupabaseClient,
  user: User,
  opts: WorkflowOptions = {},
): Promise<SendResult> {
  if (!user.email) return { status: "failed", error: "Account has no email address" };
  const cfg = getEmailConfig();
  const variant = await signupVariant(admin, user.id);
  const meta = user.user_metadata ?? {};
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, business_name")
    .eq("id", user.id)
    .maybeSingle();
  const fullName = profile?.full_name || meta.full_name || "";

  return await sendTemplatedEmail(admin, {
    templateKey: variant.key,
    to: user.email,
    recipientUserId: user.id,
    variables: {
      first_name: firstNameFrom(fullName, user.email),
      email: user.email,
      company_name: variant.companyName || profile?.business_name || meta.business_name || fullName || cfg.brandName,
      role: variant.role ?? "",
      trial_days: "14",
      created_at: formatDateTime(user.created_at ?? new Date()),
    },
    dedupeKey: opts.forceNew ? `signup:${user.id}:resend:${opts.resentFrom ?? crypto.randomUUID()}` : `signup:${user.id}`,
    dedupeWindowSeconds: null,
    context: { user_id: user.id },
    triggeredBy: opts.triggeredBy,
    resentFrom: opts.resentFrom,
  });
}

// =============================================================================
// Password reset + password changed
// =============================================================================
export function passwordResetTtlMinutes(): number {
  const raw = Number(Deno.env.get("PASSWORD_RESET_TTL_MINUTES") ?? "60");
  return Number.isFinite(raw) ? Math.min(60, Math.max(15, Math.round(raw))) : 60;
}

async function userDisplayName(admin: SupabaseClient, user: User): Promise<string> {
  const { data: profile } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  return profile?.full_name || user.user_metadata?.full_name || "";
}

/** Revokes outstanding tokens, issues a new one and emails the link. */
export async function issuePasswordReset(
  admin: SupabaseClient,
  user: User,
  opts: WorkflowOptions & { ipHash?: string | null } = {},
): Promise<SendResult> {
  if (!user.email) return { status: "failed", error: "Account has no email address" };
  const ttl = passwordResetTtlMinutes();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();

  await admin
    .from("password_reset_tokens")
    .update({ revoked_at: now.toISOString() })
    .eq("user_id", user.id)
    .is("used_at", null)
    .is("revoked_at", null);

  const { data: row, error } = await admin
    .from("password_reset_tokens")
    .insert({
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: new Date(now.getTime() + ttl * 60_000).toISOString(),
      requested_ip_hash: opts.ipHash ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;

  const cfg = getEmailConfig();
  return await sendTemplatedEmail(admin, {
    templateKey: "password_reset",
    to: user.email,
    recipientUserId: user.id,
    variables: {
      first_name: firstNameFrom(await userDisplayName(admin, user), user.email),
      email: user.email,
      reset_link: `${cfg.appUrl}/reset-password?token=${encodeURIComponent(token)}`,
      expires_in: `${ttl} minutes`,
      request_time: formatDateTime(now),
    },
    dedupeKey: `password_reset:${row.id}`,
    dedupeWindowSeconds: null,
    context: { user_id: user.id },
    triggeredBy: opts.triggeredBy,
    resentFrom: opts.resentFrom,
  });
}

export async function sendPasswordChangedEmail(
  admin: SupabaseClient,
  user: User,
  opts: WorkflowOptions = {},
): Promise<SendResult> {
  if (!user.email) return { status: "failed", error: "Account has no email address" };
  return await sendTemplatedEmail(admin, {
    templateKey: "password_changed",
    to: user.email,
    recipientUserId: user.id,
    variables: {
      first_name: firstNameFrom(await userDisplayName(admin, user), user.email),
      email: user.email,
      change_time: formatDateTime(new Date()),
    },
    dedupeKey: opts.forceNew ? null : `password_changed:${user.id}`,
    dedupeWindowSeconds: 60,
    context: { user_id: user.id },
    triggeredBy: opts.triggeredBy,
    resentFrom: opts.resentFrom,
  });
}
