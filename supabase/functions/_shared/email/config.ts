// Brand and environment configuration for transactional email.
//
// Everything that differs between environments comes from edge-function
// secrets (Supabase dashboard -> Edge Functions -> Secrets). Nothing secret
// is hardcoded here; RESEND_API_KEY is read only in send.ts, on the server.

export interface EmailConfig {
  /** Public base URL of the web app. All links in emails are built from this. */
  appUrl: string;
  /** "Display Name <address@verified-domain>" */
  from: string;
  replyTo: string | null;
  brandName: string;
  tagline: string;
  companyLegalName: string;
  companyAddress: string;
  supportEmail: string;
  supportPhone: string;
  websiteUrl: string;
  /** Absolute https URL of the header logo (also used for previews). */
  logoUrl: string;
}

export const BRAND_COLORS = {
  navy: "#142e50", // matches the logo artwork background
  navyDeep: "#0f2240",
  green: "#2d863c", // --brand-green / --primary
  greenLight: "#3fa34f",
  text: "#33404f",
  muted: "#66748a",
  border: "#e3e8ef",
  surface: "#f6f8fb",
  page: "#eef2f6",
} as const;

function env(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const deno = (globalThis as any).Deno;
  const value = deno?.env?.get?.(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalises a base URL: https only (http allowed for localhost), no trailing slash. */
export function normalizeAppUrl(raw: string | undefined): string {
  const fallback = "https://majrbooks.com";
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return fallback;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return fallback;
  }
}

export function getEmailConfig(): EmailConfig {
  const appUrl = normalizeAppUrl(env("APP_URL"));
  return {
    appUrl,
    from: env("EMAIL_FROM") ?? "MAJR Books <support@majrbooks.com>",
    replyTo: env("EMAIL_REPLY_TO") ?? env("SUPPORT_EMAIL") ?? "support@prm3tax.com",
    brandName: "MAJR Books",
    tagline: "Accounting Software",
    companyLegalName: env("COMPANY_LEGAL_NAME") ?? "PRM3 Tax",
    companyAddress: env("COMPANY_ADDRESS") ?? "8108 Cliffdale Rd Suite 104, Fayetteville, NC 28314",
    supportEmail: env("SUPPORT_EMAIL") ?? "support@prm3tax.com",
    supportPhone: env("SUPPORT_PHONE") ?? "888-575-4776",
    websiteUrl: appUrl,
    logoUrl: env("EMAIL_LOGO_URL") ?? `${appUrl}/majr-books-logo-email-header.png`,
  };
}

/** Variables every template can use. */
export function globalVariables(cfg: EmailConfig, now = new Date()): Record<string, string> {
  return {
    brand_name: cfg.brandName,
    support_email: cfg.supportEmail,
    support_phone: cfg.supportPhone,
    company_address: cfg.companyAddress,
    app_url: cfg.appUrl,
    login_url: `${cfg.appUrl}/auth`,
    forgot_password_url: `${cfg.appUrl}/auth?forgot=1`,
    current_year: String(now.getFullYear()),
  };
}

/** "December 2, 2026 at 3:15 PM ET" */
export function formatDateTime(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const date = d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} at ${time} ET`;
}

export function formatDate(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** First name from a full name, falling back to the email's local part. */
export function firstNameFrom(fullName: string | null | undefined, email?: string | null): string {
  const name = (fullName ?? "").trim();
  if (name) return name.split(/\s+/)[0];
  const local = (email ?? "").split("@")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "there";
}

/** j***@example.com — for console logs. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.charAt(0)}***@${domain}`;
}
