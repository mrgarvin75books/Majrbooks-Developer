// Built-in transactional email templates.
//
// Each template has editable text (subject, preheader, heading, body,
// secondary_body, cta_label) that admins may override from the Admin ->
// Email Notifications screen, plus fixed structure (details card, button,
// security notice) that keeps every email on-brand.
//
// Text fields use {{variable}} placeholders and a tiny, safe markup:
//   blank line        -> new paragraph
//   "- item"          -> bullet list        "1. item" -> numbered list
//   "## Title"        -> small section heading
//   **bold**          -> bold               bare https:// URLs become links
//   {{#if var}}...{{/if}} -> shown only when var has a value
// Variable values are always HTML-escaped; raw HTML is never accepted.

export type TemplateKey =
  | "client_invitation"
  | "staff_invitation"
  | "signup_client"
  | "signup_staff"
  | "signup_owner"
  | "password_reset"
  | "password_changed";

export const TEMPLATE_KEYS: TemplateKey[] = [
  "client_invitation",
  "staff_invitation",
  "signup_client",
  "signup_staff",
  "signup_owner",
  "password_reset",
  "password_changed",
];

export const EDITABLE_FIELDS = [
  "subject",
  "preheader",
  "heading",
  "body",
  "secondary_body",
  "cta_label",
] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];
export type TemplateContent = Record<EditableField, string>;

export interface TemplateDefinition {
  key: TemplateKey;
  name: string;
  description: string;
  audience: "Client" | "Staff" | "Account owner" | "All users";
  trigger: string;
  /** Small label above the heading. */
  eyebrow: string;
  /** Variable that holds the button URL. */
  ctaUrlVar: string;
  /** Key/value rows shown in the details card. Values may contain {{vars}}. */
  details: { label: string; value: string }[];
  /** Optional quoted message (e.g. the inviter's personal note). */
  quote?: { textVar: string; authorVar: string };
  /** Boxed notice under the button. */
  notice?: { tone: "info" | "security"; title: string; text: string };
  /** Footer line explaining why the recipient got this email. */
  reason: string;
  /** Variables specific to this template (globals are always available). */
  variables: string[];
  /** Whether a failed send can be retried from the admin screen. */
  resendable: boolean;
  defaults: TemplateContent;
  /** Realistic values for previews and test sends. */
  sample: Record<string, string>;
}

export const GLOBAL_VARIABLES = [
  "brand_name",
  "support_email",
  "support_phone",
  "company_address",
  "app_url",
  "login_url",
  "forgot_password_url",
  "current_year",
];

const SAMPLE_EXPIRY = "December 2, 2026 at 5:00 PM ET";

export const TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  client_invitation: {
    key: "client_invitation",
    name: "Client Invitation",
    description: "Invites a client to create their secure client portal account.",
    audience: "Client",
    trigger: "Admin or staff sends or resends a client invitation",
    eyebrow: "Client Portal Invitation",
    ctaUrlVar: "invitation_link",
    details: [
      { label: "Invited by", value: "{{company_name}}" },
      { label: "Your email", value: "{{email}}" },
      { label: "Invitation expires", value: "{{expiration_date}}" },
    ],
    quote: { textVar: "personal_message", authorVar: "company_name" },
    notice: {
      tone: "info",
      title: "Need help?",
      text:
        "This invitation is unique to you and can be used once. Questions about your account? Email {{support_email}} or call {{support_phone}}.",
    },
    reason: "You received this email because {{company_name}} invited you to their MAJR Books client portal.",
    variables: [
      "first_name",
      "client_name",
      "email",
      "company_name",
      "personal_message",
      "invitation_link",
      "expiration_date",
    ],
    resendable: true,
    defaults: {
      subject: "You're Invited! Access Your Client Portal",
      preheader: "{{company_name}} has invited you to your secure MAJR Books client portal.",
      heading: "Welcome, {{first_name}}! Your client portal is ready.",
      body:
        "Hi {{first_name}},\n\n" +
        "**{{company_name}}** has invited you to their secure client portal on MAJR Books — one place to share documents, view invoices, and work with your bookkeeping and tax team.\n\n" +
        "An invitation has been created for **{{email}}**. Accept it below to activate your account.",
      secondary_body:
        "## Creating your password\n" +
        "1. Click **Accept Invitation** — your name and email are already filled in.\n" +
        "2. Choose a strong password of at least 8 characters, mixing letters, numbers, and a symbol.\n" +
        "3. If we ask you to confirm your email address, click the link in that message.\n" +
        "4. Sign in any time at {{login_url}}\n\n" +
        "Please accept before **{{expiration_date}}**. After that, ask {{company_name}} to send a new invitation.",
      cta_label: "Accept Invitation",
    },
    sample: {
      first_name: "Jordan",
      client_name: "Jordan Ellis",
      email: "jordan.ellis@example.com",
      company_name: "PRM3 Tax",
      personal_message: "Looking forward to working with you this tax season!",
      invitation_link: "https://majrbooks.com/accept-client-invite?token=sample-token",
      expiration_date: SAMPLE_EXPIRY,
    },
  },

  staff_invitation: {
    key: "staff_invitation",
    name: "Staff Invitation",
    description: "Invites a team member (administrator, accountant, or staff) to activate their account.",
    audience: "Staff",
    trigger: "Account owner invites or re-invites a team member",
    eyebrow: "Team Invitation",
    ctaUrlVar: "invitation_link",
    details: [
      { label: "Organization", value: "{{company_name}}" },
      { label: "Assigned role", value: "{{role}}" },
      { label: "Sign-in email", value: "{{email}}" },
      { label: "Portal login", value: "{{login_url}}" },
      { label: "Invitation expires", value: "{{expiration_date}}" },
    ],
    notice: {
      tone: "security",
      title: "Keep your credentials confidential",
      text:
        "Never share your password or this invitation link. {{brand_name}} and {{company_name}} will never ask for your password by email or phone.",
    },
    reason: "You received this email because {{company_name}} added you as a team member on MAJR Books.",
    variables: [
      "first_name",
      "last_name",
      "full_name",
      "email",
      "company_name",
      "inviter_name",
      "role",
      "role_description",
      "invitation_link",
      "expiration_date",
    ],
    resendable: true,
    defaults: {
      subject: "Welcome to the Team! Your Account Invitation Is Ready",
      preheader: "Activate your {{company_name}} account on MAJR Books.",
      heading: "Welcome to the team, {{first_name}}!",
      body:
        "Hi {{first_name}},\n\n" +
        "**{{company_name}}** has invited you to join their team on MAJR Books.\n\n" +
        "You've been assigned the **{{role}}** role. {{role_description}}\n\n" +
        "Your access is managed by {{company_name}} — no payment or subscription is needed from you.",
      secondary_body:
        "## Setting up your password\n" +
        "1. Click **Activate Your Account** — your email is already filled in.\n" +
        "2. Create a password of at least 8 characters, mixing letters, numbers, and a symbol.\n" +
        "3. Confirm your email address if prompted.\n" +
        "4. From then on, sign in at {{login_url}}\n\n" +
        "This invitation expires on **{{expiration_date}}**.",
      cta_label: "Activate Your Account",
    },
    sample: {
      first_name: "Taylor",
      last_name: "Brooks",
      full_name: "Taylor Brooks",
      email: "taylor.brooks@example.com",
      company_name: "PRM3 Tax",
      inviter_name: "Alex Simmons",
      role: "Accountant",
      role_description: "You'll have access to bookkeeping, invoicing, and tax preparation tools.",
      invitation_link: "https://majrbooks.com/accept-invite?token=sample-token",
      expiration_date: SAMPLE_EXPIRY,
    },
  },

  signup_client: {
    key: "signup_client",
    name: "Account Created — Client",
    description: "Confirms a client's registration after they accept their invitation.",
    audience: "Client",
    trigger: "Client completes registration from an invitation",
    eyebrow: "Account Confirmation",
    ctaUrlVar: "login_url",
    details: [
      { label: "Registered email", value: "{{email}}" },
      { label: "Account type", value: "Client Portal" },
      { label: "Connected to", value: "{{company_name}}" },
      { label: "Created", value: "{{created_at}}" },
    ],
    notice: {
      tone: "security",
      title: "Didn't create this account?",
      text: "Contact us right away at {{support_email}} or {{support_phone}}.",
    },
    reason: "You received this email because a client portal account was created with this address.",
    variables: ["first_name", "email", "company_name", "created_at"],
    resendable: true,
    defaults: {
      subject: "Your Account Has Been Successfully Created!",
      preheader: "Welcome to your MAJR Books client portal.",
      heading: "You're all set, {{first_name}}!",
      body:
        "Hi {{first_name}},\n\n" +
        "Welcome to MAJR Books! Your client portal account has been created successfully and is connected to **{{company_name}}**.",
      secondary_body:
        "## Next steps\n" +
        "1. If you received a separate email asking you to confirm your address, click that link first.\n" +
        "2. Sign in with **{{email}}** and the password you just created.\n" +
        "3. Complete your profile, then upload documents and review invoices from your portal.",
      cta_label: "Login to Your Account",
    },
    sample: {
      first_name: "Jordan",
      email: "jordan.ellis@example.com",
      company_name: "PRM3 Tax",
      created_at: "November 25, 2026 at 10:42 AM ET",
    },
  },

  signup_staff: {
    key: "signup_staff",
    name: "Account Created — Staff",
    description: "Confirms a team member's registration after they activate their invitation.",
    audience: "Staff",
    trigger: "Staff member completes registration from an invitation",
    eyebrow: "Account Confirmation",
    ctaUrlVar: "login_url",
    details: [
      { label: "Registered email", value: "{{email}}" },
      { label: "Organization", value: "{{company_name}}" },
      { label: "Role", value: "{{role}}" },
      { label: "Created", value: "{{created_at}}" },
    ],
    notice: {
      tone: "security",
      title: "Keep your credentials confidential",
      text:
        "Never share your password. Didn't create this account? Contact {{support_email}} or {{support_phone}} immediately.",
    },
    reason: "You received this email because a team account was created with this address.",
    variables: ["first_name", "email", "company_name", "role", "created_at"],
    resendable: true,
    defaults: {
      subject: "Your Account Has Been Successfully Created!",
      preheader: "Your {{company_name}} team account is ready.",
      heading: "Welcome aboard, {{first_name}}!",
      body:
        "Hi {{first_name}},\n\n" +
        "Your team account with **{{company_name}}** has been created successfully. You've joined as **{{role}}**.",
      secondary_body:
        "## Next steps\n" +
        "1. If you received a separate email asking you to confirm your address, click that link first.\n" +
        "2. Sign in with **{{email}}** at {{login_url}}\n" +
        "3. Your tools and permissions are set by {{company_name}}. Contact your administrator if something is missing.",
      cta_label: "Login to Your Account",
    },
    sample: {
      first_name: "Taylor",
      email: "taylor.brooks@example.com",
      company_name: "PRM3 Tax",
      role: "Accountant",
      created_at: "November 25, 2026 at 10:42 AM ET",
    },
  },

  signup_owner: {
    key: "signup_owner",
    name: "Account Created — Account Owner",
    description: "Welcomes a business owner who signs up directly and starts their free trial.",
    audience: "Account owner",
    trigger: "Business owner signs up on the website",
    eyebrow: "Account Confirmation",
    ctaUrlVar: "login_url",
    details: [
      { label: "Registered email", value: "{{email}}" },
      { label: "Business", value: "{{company_name}}" },
      { label: "Plan", value: "{{trial_days}}-day free trial" },
      { label: "Created", value: "{{created_at}}" },
    ],
    notice: {
      tone: "security",
      title: "Didn't create this account?",
      text: "Contact us right away at {{support_email}} or {{support_phone}}.",
    },
    reason: "You received this email because a MAJR Books account was created with this address.",
    variables: ["first_name", "email", "company_name", "trial_days", "created_at"],
    resendable: true,
    defaults: {
      subject: "Your Account Has Been Successfully Created!",
      preheader: "Your {{trial_days}}-day free trial of MAJR Books has started.",
      heading: "Welcome to MAJR Books, {{first_name}}!",
      body:
        "Hi {{first_name}},\n\n" +
        "Your account has been created successfully, and your **{{trial_days}}-day free trial** has started with full access to bookkeeping, invoicing, payroll, and tax tools.",
      secondary_body:
        "## Next steps\n" +
        "1. If you received a separate email asking you to confirm your address, click that link first.\n" +
        "2. Sign in with **{{email}}** at {{login_url}}\n" +
        "3. Connect your bank, invite your team, and send your first invoice.\n\n" +
        "When your trial ends you can choose the plan that fits your business.",
      cta_label: "Login to Your Account",
    },
    sample: {
      first_name: "Morgan",
      email: "morgan@example.com",
      company_name: "Rivera Consulting LLC",
      trial_days: "14",
      created_at: "November 25, 2026 at 10:42 AM ET",
    },
  },

  password_reset: {
    key: "password_reset",
    name: "Password Reset",
    description: "Sends a secure, single-use, time-limited link to choose a new password.",
    audience: "All users",
    trigger: "User requests a password reset",
    eyebrow: "Account Security",
    ctaUrlVar: "reset_link",
    details: [
      { label: "Account", value: "{{email}}" },
      { label: "Requested", value: "{{request_time}}" },
      { label: "Link expires in", value: "{{expires_in}}" },
    ],
    notice: {
      tone: "security",
      title: "Didn't request this?",
      text:
        "You can safely ignore this email — your password will not change. For your security this link works only once and expires in {{expires_in}}. We will never ask for your password by email.",
    },
    reason: "You received this email because a password reset was requested for your MAJR Books account.",
    variables: ["first_name", "email", "reset_link", "expires_in", "request_time"],
    resendable: true,
    defaults: {
      subject: "Password Reset Request – Secure Your Account",
      preheader: "Use this secure link within {{expires_in}} to choose a new password.",
      heading: "Reset your password",
      body:
        "Hi {{first_name}},\n\n" +
        "We received a request to reset the password for your MAJR Books account (**{{email}}**). Click the button below to choose a new one.",
      secondary_body: "",
      cta_label: "Reset Password",
    },
    sample: {
      first_name: "Jordan",
      email: "jordan.ellis@example.com",
      reset_link: "https://majrbooks.com/reset-password?token=sample-token",
      expires_in: "60 minutes",
      request_time: "November 25, 2026 at 10:42 AM ET",
    },
  },

  password_changed: {
    key: "password_changed",
    name: "Password Changed",
    description: "Confirms that an account password was changed.",
    audience: "All users",
    trigger: "User changes their password or completes a reset",
    eyebrow: "Account Security",
    ctaUrlVar: "login_url",
    details: [
      { label: "Account", value: "{{email}}" },
      { label: "Changed", value: "{{change_time}}" },
    ],
    notice: {
      tone: "security",
      title: "Didn't make this change?",
      text:
        "Reset your password immediately at {{forgot_password_url}} and contact {{support_email}} or {{support_phone}} so we can secure your account.",
    },
    reason: "You received this security notice because the password on your MAJR Books account changed.",
    variables: ["first_name", "email", "change_time"],
    resendable: true,
    defaults: {
      subject: "Your MAJR Books Password Was Changed",
      preheader: "This is a confirmation that your password was updated.",
      heading: "Your password was changed",
      body:
        "Hi {{first_name}},\n\n" +
        "The password for your MAJR Books account (**{{email}}**) was changed successfully. If you made this change, no further action is needed.",
      secondary_body: "",
      cta_label: "Login to Your Account",
    },
    sample: {
      first_name: "Jordan",
      email: "jordan.ellis@example.com",
      change_time: "November 25, 2026 at 10:42 AM ET",
    },
  },
};

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && (TEMPLATE_KEYS as string[]).includes(value);
}

/** Max lengths enforced when an admin saves an override. */
export const FIELD_LIMITS: Record<EditableField, number> = {
  subject: 200,
  preheader: 250,
  heading: 200,
  body: 5000,
  secondary_body: 5000,
  cta_label: 60,
};

/** Merges stored overrides (null/blank = use default) onto the defaults. */
export function effectiveContent(
  def: TemplateDefinition,
  override?: Partial<Record<EditableField, string | null>> | null,
): TemplateContent {
  const out = { ...def.defaults };
  if (!override) return out;
  for (const field of EDITABLE_FIELDS) {
    const v = override[field];
    if (typeof v === "string" && (v.trim() !== "" || field === "secondary_body" || field === "preheader")) {
      // An override is only stored when it differs from the default, so an
      // empty optional field means "intentionally blank".
      out[field] = v;
    }
  }
  return out;
}

export const ROLE_LABELS: Record<string, { label: string; description: string }> = {
  admin: {
    label: "Administrator",
    description:
      "You'll have full access to manage the organization's books, team members, and settings.",
  },
  accountant: {
    label: "Accountant",
    description: "You'll have access to bookkeeping, invoicing, and tax preparation tools.",
  },
  employee: {
    label: "Staff",
    description: "You'll have access to the specific areas your administrator has enabled for you.",
  },
};

export function describeRole(role: string | null | undefined): { label: string; description: string } {
  const key = String(role ?? "").toLowerCase();
  return ROLE_LABELS[key] ?? {
    label: key ? key.charAt(0).toUpperCase() + key.slice(1) : "Team Member",
    description: "Your administrator controls which areas you can access.",
  };
}
