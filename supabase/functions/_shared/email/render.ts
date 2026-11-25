// Renders a template into a branded, responsive HTML email plus a plain-text
// alternative. Pure functions only (no network, no Deno APIs) so it can be
// unit-tested and used for admin previews.

import { BRAND_COLORS as C, type EmailConfig, globalVariables } from "./config.ts";
import { type TemplateContent, type TemplateDefinition } from "./templates.ts";

export type Vars = Record<string, string | null | undefined>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderOptions {
  /** Image src for the header logo: "cid:..." when attached inline, else a URL. */
  logoSrc?: string;
  now?: Date;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
const IF_RE = /\{\{#if\s+([a-z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/gi;

function hasValue(vars: Vars, name: string): boolean {
  const v = vars[name];
  return typeof v === "string" && v.trim() !== "";
}

function applyConditionals(text: string, vars: Vars): string {
  return text.replace(IF_RE, (_m, name: string, inner: string) => (hasValue(vars, name) ? inner : ""));
}

/** Only these variables are rendered as clickable links. */
function isLinkVar(name: string): boolean {
  return /(_url|_link)$/.test(name);
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function linkHtml(url: string, label?: string): string {
  const href = safeHref(url);
  if (!href) return escapeHtml(label ?? url);
  return `<a href="${escapeHtml(href)}" target="_blank" style="color:${C.green};text-decoration:underline;word-break:break-all;">${escapeHtml(label ?? url)}</a>`;
}

/** Plain substitution for single-line fields (subject, preheader). No HTML. */
export function interpolateText(text: string, vars: Vars): string {
  return applyConditionals(text, vars)
    .replace(VAR_RE, (_m, name: string) => String(vars[name] ?? ""))
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Substitution for inline HTML (headings, detail values): escaped, link vars linked. */
export function interpolateInlineHtml(text: string, vars: Vars): string {
  return lineHtml(applyConditionals(text, vars).replace(/[\r\n]+/g, " "), vars);
}

/** **bold** and bare URLs written directly in template text. Input is already escaped. */
function inlineMarkup(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C.navyDeep};font-weight:600;">$1</strong>`)
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => `${pre}${linkHtml(url.replace(/&amp;/g, "&"))}`);
}

/**
 * Bold markers may span a variable ("**{{company_name}}**"), so bold is applied
 * to the whole line after substitution, using placeholders that cannot occur
 * in escaped text.
 */
function lineHtml(line: string, vars: Vars): string {
  const parts: string[] = [];
  const marked = line.replace(VAR_RE, (_m, name: string) => {
    const value = String(vars[name] ?? "");
    parts.push(isLinkVar(name) && value ? linkHtml(value) : escapeHtml(value));
    return `\u0000${parts.length - 1}\u0000`;
  });
  const html = inlineMarkup(escapeHtml(marked));
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => parts[Number(i)]);
}

const P_STYLE = `margin:0 0 16px;color:${C.text};font-size:15px;line-height:1.65;`;
const LI_STYLE = `margin:0 0 8px;color:${C.text};font-size:15px;line-height:1.6;`;
const H_STYLE = `margin:24px 0 10px;color:${C.navyDeep};font-size:15px;font-weight:700;letter-spacing:0.2px;`;

/** Converts the safe mini-markup into HTML blocks. */
export function markupToHtml(text: string, vars: Vars): string {
  const source = applyConditionals(text ?? "", vars).replace(/\r\n/g, "\n").trim();
  if (!source) return "";

  const blocks: string[] = [];
  const paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p class="em-p" style="${P_STYLE}">${paragraph.map((l) => lineHtml(l, vars)).join("<br>")}</p>`);
      paragraph.length = 0;
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      blocks.push(
        `<${tag} style="margin:0 0 16px;padding:0 0 0 22px;">${
          list.items.map((i) => `<li style="${LI_STYLE}">${lineHtml(i, vars)}</li>`).join("")
        }</${tag}>`,
      );
      list = null;
    }
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<p style="${H_STYLE}">${lineHtml(heading[1], vars)}</p>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("\n");
}

/** Plain-text rendering of the mini-markup. */
export function markupToText(text: string, vars: Vars): string {
  return applyConditionals(text ?? "", vars)
    .replace(VAR_RE, (_m, name: string) => String(vars[name] ?? ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,3}\s+(.*)$/gm, (_m, t: string) => t.toUpperCase())
    .replace(/^[*•]\s+/gm, "- ")
    .trim();
}

function button(label: string, url: string): string {
  const href = safeHref(url) ?? "#";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="em-btn-wrap" style="margin:8px 0 8px;">
  <tr>
    <td align="center" bgcolor="${C.green}" class="em-btn-cell" style="border-radius:8px;background:${C.green};">
      <a href="${escapeHtml(href)}" target="_blank" class="em-btn"
         style="display:inline-block;padding:15px 34px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;letter-spacing:0.2px;">
        ${escapeHtml(label)} &rarr;
      </a>
    </td>
  </tr>
</table>`;
}

function detailsCard(rows: { label: string; value: string }[]): string {
  if (!rows.length) return "";
  const trs = rows
    .map(
      (r, i) => `
      <tr>
        <td class="em-dl" style="padding:11px 18px;${i ? `border-top:1px solid ${C.border};` : ""}color:${C.muted};font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
        <td class="em-dv" style="padding:11px 18px;${i ? `border-top:1px solid ${C.border};` : ""}color:${C.navyDeep};font-size:14px;font-weight:600;text-align:right;word-break:break-word;">${r.value}</td>
      </tr>`,
    )
    .join("");
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 26px;background:${C.surface};border:1px solid ${C.border};border-radius:10px;border-collapse:separate;">
  ${trs}
</table>`;
}

function quoteBlock(text: string, author: string): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;">
  <tr>
    <td style="border-left:3px solid ${C.green};background:#f3faf4;border-radius:0 8px 8px 0;padding:14px 18px;">
      <p style="margin:0;color:${C.text};font-size:15px;line-height:1.6;font-style:italic;">&ldquo;${escapeHtml(text).replace(/\n/g, "<br>")}&rdquo;</p>
      <p style="margin:8px 0 0;color:${C.green};font-size:13px;font-weight:600;">&mdash; ${escapeHtml(author)}</p>
    </td>
  </tr>
</table>`;
}

function noticeBlock(tone: "info" | "security", title: string, html: string): string {
  const accent = tone === "security" ? "#c2410c" : C.navy;
  const bg = tone === "security" ? "#fff7ed" : "#f1f5fb";
  const icon = tone === "security" ? "&#128274;" : "&#9432;";
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;">
  <tr>
    <td style="background:${bg};border:1px solid ${tone === "security" ? "#fed7aa" : "#dbe4f0"};border-radius:10px;padding:16px 18px;">
      <p style="margin:0 0 4px;color:${accent};font-size:13px;font-weight:700;letter-spacing:0.3px;">${icon}&nbsp; ${escapeHtml(title)}</p>
      <p style="margin:0;color:${C.text};font-size:13px;line-height:1.6;">${html}</p>
    </td>
  </tr>
</table>`;
}

export function renderEmail(
  def: TemplateDefinition,
  content: TemplateContent,
  variables: Vars,
  cfg: EmailConfig,
  opts: RenderOptions = {},
): RenderedEmail {
  const vars: Vars = { ...globalVariables(cfg, opts.now), ...variables };
  const subject = interpolateText(content.subject, vars).slice(0, 250);
  const preheader = interpolateText(content.preheader, vars);
  const heading = interpolateInlineHtml(content.heading, vars);
  const ctaUrl = String(vars[def.ctaUrlVar] ?? "");
  const ctaLabel = interpolateText(content.cta_label, vars) || "Open MAJR Books";
  const logoSrc = opts.logoSrc ?? cfg.logoUrl;

  const detailRows = def.details
    .map((d) => ({ label: d.label, value: interpolateInlineHtml(d.value, vars), raw: interpolateText(d.value, vars) }))
    .filter((d) => d.raw !== "");

  const quoteText = def.quote ? String(vars[def.quote.textVar] ?? "").trim() : "";
  const quoteAuthor = def.quote ? String(vars[def.quote.authorVar] ?? "") : "";

  const year = vars.current_year ?? String(new Date().getFullYear());
  const reason = interpolateInlineHtml(def.reason, vars);
  const supportLink = `<a href="mailto:${escapeHtml(cfg.supportEmail)}" style="color:${C.green};text-decoration:none;">${escapeHtml(cfg.supportEmail)}</a>`;
  const phoneHref = cfg.supportPhone.replace(/[^\d+]/g, "");

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { color:${C.green}; }
  @media only screen and (max-width:620px) {
    .em-outer { padding:0 !important; }
    .em-card { border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
    .em-pad { padding:28px 22px !important; }
    .em-head { padding:22px 20px !important; }
    .em-logo { width:200px !important; }
    .em-h1 { font-size:22px !important; line-height:30px !important; }
    .em-btn-wrap { width:100% !important; }
    .em-btn-cell { display:block !important; width:100% !important; }
    .em-btn { display:block !important; text-align:center !important; padding:16px 12px !important; }
    .em-dl, .em-dv { display:block !important; width:auto !important; text-align:left !important; }
    .em-dl { padding:12px 16px 0 !important; }
    .em-dv { border-top:0 !important; padding:2px 16px 12px !important; }
    .em-foot { padding:24px 22px !important; }
  }
</style>
<!--[if mso]><style>body, table, td, p, a { font-family: Arial, sans-serif !important; }</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${C.page};font-family:'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${escapeHtml(preheader)}${"&#8203;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr>
    <td align="center" class="em-outer" style="padding:36px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="em-card" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${C.border};border-radius:14px;overflow:hidden;">
        <tr>
          <td align="center" bgcolor="${C.navy}" class="em-head" style="background:${C.navy};padding:30px 32px;">
            <a href="${escapeHtml(cfg.appUrl)}" target="_blank" style="text-decoration:none;">
              <img src="${escapeHtml(logoSrc)}" width="240" alt="${escapeHtml(cfg.brandName)} — ${escapeHtml(cfg.tagline)}" class="em-logo" style="display:block;width:240px;max-width:100%;height:auto;margin:0 auto;color:#ffffff;font-size:20px;font-weight:700;">
            </a>
          </td>
        </tr>
        <tr>
          <td height="4" style="height:4px;line-height:4px;font-size:0;background:${C.green};background-image:linear-gradient(90deg,${C.green},${C.greenLight});">&nbsp;</td>
        </tr>
        <tr>
          <td class="em-pad" style="padding:40px 44px 36px;">
            <p style="margin:0 0 10px;color:${C.green};font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">${escapeHtml(def.eyebrow)}</p>
            <h1 class="em-h1" style="margin:0 0 22px;color:${C.navyDeep};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.2px;">${heading}</h1>
            ${markupToHtml(content.body, vars)}
            ${quoteText ? quoteBlock(quoteText, quoteAuthor) : ""}
            ${detailsCard(detailRows)}
            ${ctaUrl ? button(ctaLabel, ctaUrl) : ""}
            ${
    ctaUrl
      ? `<p style="margin:14px 0 0;color:${C.muted};font-size:12px;line-height:1.6;">Button not working? Copy and paste this link into your browser:<br><span style="color:${C.green};word-break:break-all;">${linkHtml(ctaUrl)}</span></p>`
      : ""
  }
            ${content.secondary_body.trim() ? `<div style="margin-top:28px;padding-top:4px;border-top:1px solid ${C.border};">${markupToHtml(content.secondary_body, vars)}</div>` : ""}
            ${def.notice ? noticeBlock(def.notice.tone, def.notice.title, interpolateInlineHtml(def.notice.text, vars)) : ""}
            <p style="margin:28px 0 0;color:${C.text};font-size:15px;line-height:1.6;">Warm regards,<br><strong style="color:${C.navyDeep};">The ${escapeHtml(cfg.brandName)} Team</strong></p>
          </td>
        </tr>
        <tr>
          <td class="em-foot" bgcolor="${C.surface}" style="background:${C.surface};border-top:1px solid ${C.border};padding:28px 44px;">
            <p style="margin:0 0 6px;color:${C.navyDeep};font-size:14px;font-weight:700;">${escapeHtml(cfg.brandName)} <span style="color:${C.green};font-weight:600;">· ${escapeHtml(cfg.tagline)}</span></p>
            <p style="margin:0 0 12px;color:${C.muted};font-size:12px;line-height:1.7;">
              A ${escapeHtml(cfg.companyLegalName)} company · ${escapeHtml(cfg.companyAddress)}<br>
              ${supportLink} &nbsp;·&nbsp; <a href="tel:${escapeHtml(phoneHref)}" style="color:${C.muted};text-decoration:none;">${escapeHtml(cfg.supportPhone)}</a> &nbsp;·&nbsp; <a href="${escapeHtml(cfg.websiteUrl)}" target="_blank" style="color:${C.muted};text-decoration:none;">${escapeHtml(cfg.websiteUrl.replace(/^https?:\/\//, ""))}</a>
            </p>
            <p style="margin:0;color:#94a0b2;font-size:11px;line-height:1.6;">${reason}<br>&copy; ${escapeHtml(year)} ${escapeHtml(cfg.brandName)} by ${escapeHtml(cfg.companyLegalName)}. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const textParts = [
    interpolateText(content.heading, vars).replace(/\*\*/g, ""),
    "",
    markupToText(content.body, vars),
  ];
  if (quoteText) textParts.push("", `"${quoteText}" — ${quoteAuthor}`);
  if (detailRows.length) textParts.push("", ...detailRows.map((d) => `${d.label}: ${d.raw}`));
  if (ctaUrl) textParts.push("", `${ctaLabel}: ${ctaUrl}`);
  if (content.secondary_body.trim()) textParts.push("", markupToText(content.secondary_body, vars));
  if (def.notice) textParts.push("", `${def.notice.title}: ${interpolateText(def.notice.text, vars)}`);
  textParts.push(
    "",
    `— The ${cfg.brandName} Team`,
    "",
    `${cfg.brandName} · ${cfg.companyLegalName} · ${cfg.companyAddress}`,
    `${cfg.supportEmail} · ${cfg.supportPhone} · ${cfg.websiteUrl}`,
    interpolateText(def.reason, vars),
  );

  return { subject, html, text: textParts.join("\n").replace(/\n{3,}/g, "\n\n") };
}
