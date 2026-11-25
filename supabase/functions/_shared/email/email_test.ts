// Run: deno test --allow-env supabase/functions/_shared/email/
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { formatDateTime, getEmailConfig, normalizeAppUrl } from "./config.ts";
import { interpolateText, markupToHtml, renderEmail } from "./render.ts";
import { scrubError } from "./send.ts";
import { describeRole, effectiveContent, TEMPLATE_KEYS, TEMPLATES } from "./templates.ts";

const cfg = getEmailConfig();

Deno.test("every template renders with its sample data and no leftover placeholders", () => {
  for (const key of TEMPLATE_KEYS) {
    const def = TEMPLATES[key];
    const out = renderEmail(def, def.defaults, def.sample, cfg);
    assertFalse(/\{\{|\}\}/.test(out.html), `${key}: unresolved placeholder in html`);
    assertFalse(/\{\{|\}\}/.test(out.text), `${key}: unresolved placeholder in text`);
    assertFalse(/\*\*/.test(out.html), `${key}: raw bold markers in html`);
    assertStringIncludes(out.html, cfg.logoUrl);
    assertStringIncludes(out.html, "8108 Cliffdale Rd Suite 104");
    assertStringIncludes(out.html, "support@prm3tax.com");
    assertStringIncludes(out.html, 'name="viewport"');
    assertStringIncludes(out.html, "@media only screen and (max-width:620px)");
    const ctaUrl = def.sample[def.ctaUrlVar] ?? `${cfg.appUrl}/auth`;
    assertStringIncludes(out.html, `href="${ctaUrl.replace(/&/g, "&amp;")}"`);
    assertStringIncludes(out.text, ctaUrl);
  }
});

Deno.test("required subjects match the specification", () => {
  const subject = (k: keyof typeof TEMPLATES) =>
    renderEmail(TEMPLATES[k], TEMPLATES[k].defaults, TEMPLATES[k].sample, cfg).subject;
  assertEquals(subject("client_invitation"), "You're Invited! Access Your Client Portal");
  assertEquals(subject("staff_invitation"), "Welcome to the Team! Your Account Invitation Is Ready");
  assertEquals(subject("signup_client"), "Your Account Has Been Successfully Created!");
  assertEquals(subject("signup_staff"), "Your Account Has Been Successfully Created!");
  assertEquals(subject("signup_owner"), "Your Account Has Been Successfully Created!");
  assertEquals(subject("password_reset"), "Password Reset Request – Secure Your Account");
});

Deno.test("required content is present", () => {
  const html = (k: keyof typeof TEMPLATES) =>
    renderEmail(TEMPLATES[k], TEMPLATES[k].defaults, TEMPLATES[k].sample, cfg).html;
  const client = html("client_invitation");
  assertStringIncludes(client, "Hi Jordan");
  assertStringIncludes(client, "Accept Invitation");
  assertStringIncludes(client, "December 2, 2026 at 5:00 PM ET");
  assertStringIncludes(client, "Creating your password");
  assertStringIncludes(client, "Looking forward to working with you");

  const staff = html("staff_invitation");
  assertStringIncludes(staff, "Activate Your Account");
  assertStringIncludes(staff, "Accountant");
  assertStringIncludes(staff, `${cfg.appUrl}/auth`);
  assertStringIncludes(staff, "Keep your credentials confidential");

  const signup = html("signup_client");
  assertStringIncludes(signup, "jordan.ellis@example.com");
  assertStringIncludes(signup, "Login to Your Account");
  assertStringIncludes(signup, "Next steps");

  const reset = html("password_reset");
  assertStringIncludes(reset, "Reset Password");
  assertStringIncludes(reset, "60 minutes");
  assertStringIncludes(reset, "safely ignore");
  assertFalse(/password:\s*\S/i.test(reset), "reset email must never contain a password");
});

Deno.test("variable values are HTML-escaped", () => {
  const def = TEMPLATES.client_invitation;
  const out = renderEmail(def, def.defaults, {
    ...def.sample,
    first_name: '<script>alert("x")</script>',
    company_name: "Evil & Co <img src=x onerror=1>",
    personal_message: "</td><a href='https://phish.example'>click</a>",
  }, cfg);
  assertFalse(out.html.includes("<script>"));
  assertFalse(out.html.includes("<img src=x"));
  assertFalse(out.html.includes("href='https://phish.example'"));
  assertStringIncludes(out.html, "&lt;script&gt;");
  assertStringIncludes(out.html, "Evil &amp; Co");
});

Deno.test("only *_url/*_link variables become links; javascript: is never linked", () => {
  const html = markupToHtml("Visit {{company_name}} or {{login_url}} or {{bad_link}}", {
    company_name: "https://evil.example",
    login_url: "https://majrbooks.com/auth",
    bad_link: "javascript:alert(1)",
  });
  assertStringIncludes(html, 'href="https://majrbooks.com/auth"');
  assertFalse(html.includes('href="https://evil.example'));
  assertFalse(html.includes('href="javascript:'));
});

Deno.test("mini-markup: paragraphs, lists, headings, bold around variables, conditionals", () => {
  const html = markupToHtml(
    "## Title\nHello **{{name}}**\n\n- one\n- two\n\n1. first\n2. second\n\n{{#if note}}Note: {{note}}{{/if}}{{#if missing}}HIDDEN{{/if}}",
    { name: "Ana", note: "hi", missing: "" },
  );
  assertStringIncludes(html, "Title</p>");
  assertMatch(html, /<strong[^>]*>Ana<\/strong>/);
  assertStringIncludes(html, "<ul");
  assertStringIncludes(html, "<ol");
  assertStringIncludes(html, "Note: hi");
  assertFalse(html.includes("HIDDEN"));
});

Deno.test("subject lines cannot be split by newlines (header injection)", () => {
  assertEquals(interpolateText("Hi {{n}}", { n: "a\r\nBcc: x@y.z" }), "Hi a Bcc: x@y.z");
});

Deno.test("admin overrides merge onto defaults; blank required fields fall back", () => {
  const def = TEMPLATES.password_changed;
  const c = effectiveContent(def, { subject: "Custom", heading: "  ", secondary_body: "", body: null });
  assertEquals(c.subject, "Custom");
  assertEquals(c.heading, def.defaults.heading);
  assertEquals(c.body, def.defaults.body);
  assertEquals(c.secondary_body, "");
});

Deno.test("error scrubbing removes links, keys and tokens", () => {
  const s = scrubError(
    "failed for https://majrbooks.com/reset-password?token=abc key re_123456789abc token Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA",
  );
  assertFalse(s.includes("token=abc"));
  assertFalse(s.includes("re_123456789abc"));
  assertFalse(s.includes("Zm9vYmFyYmF6cXV4"));
});

Deno.test("app URL must be https (except localhost)", () => {
  assertEquals(normalizeAppUrl("https://app.majrbooks.com/"), "https://app.majrbooks.com");
  assertEquals(normalizeAppUrl("http://evil.example"), "https://majrbooks.com");
  assertEquals(normalizeAppUrl("http://localhost:8080"), "http://localhost:8080");
  assertEquals(normalizeAppUrl(undefined), "https://majrbooks.com");
});

Deno.test("roles and dates format for people", () => {
  assertEquals(describeRole("admin").label, "Administrator");
  assertEquals(describeRole("accountant").label, "Accountant");
  assertEquals(describeRole("employee").label, "Staff");
  assertEquals(formatDateTime(new Date("2026-12-02T22:00:00Z")), "December 2, 2026 at 5:00 PM ET");
  assert(TEMPLATE_KEYS.every((k) => TEMPLATES[k].resendable !== undefined));
});
