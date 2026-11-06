// AI bank-statement analysis for Schedule C / profit and loss.
//
// Claude reads the statement (PDF, CSV or pasted text) and returns every
// transaction, classified and categorised against the fixed Schedule C
// category list. It does NOT compute totals: the app adds everything up in
// exact cents (src/lib/scheduleC.ts), so totals can't be "estimated".
//
// Requires the ANTHROPIC_API_KEY secret on the Supabase project.
import Anthropic from "npm:@anthropic-ai/sdk";
import { corsHeaders, HttpError, jsonResponse, requireUser } from "../_shared/security.ts";

const MODEL = "claude-opus-5-5";
const MAX_TEXT_CHARS = 500_000;
const MAX_PDFS = 5;
const MAX_PDF_BASE64_CHARS = 20 * 1024 * 1024; // ~15 MB file
const MAX_TOTAL_BASE64_CHARS = 28 * 1024 * 1024; // API request limit is 32 MB

// Keep in sync with CATEGORIES / NON_BUSINESS_CATEGORIES in src/lib/scheduleC.ts
// (a unit test checks this list against that file).
export const CATEGORY_NAMES = [
  "Sales / gross receipts",
  "Other business income",
  "Cost of goods sold",
  "Advertising",
  "Car and truck expenses",
  "Commissions and fees",
  "Contract labor",
  "Depreciation",
  "Employee benefit programs",
  "Insurance (other than health)",
  "Mortgage interest",
  "Other interest",
  "Legal and professional services",
  "Office expense",
  "Pension and profit-sharing plans",
  "Rent or lease: vehicles and equipment",
  "Rent or lease: business property",
  "Repairs and maintenance",
  "Supplies",
  "Taxes and licenses",
  "Travel",
  "Meals",
  "Utilities",
  "Wages",
  "Software and subscriptions",
  "Bank and merchant fees",
  "Telephone and internet",
  "Postage and shipping",
  "Education and training",
  "Other expenses",
  "Transfer between accounts",
  "Owner draw or personal",
  "Needs review",
];

const TX_TYPES = ["income", "expense", "transfer", "personal", "needs_review"];

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["transactions", "flagged_items", "recurring_subscriptions", "statement_period", "notes"],
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "description", "amount", "type", "category", "notes"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          description: { type: "string" },
          amount: { type: "number", description: "Positive amount in dollars as printed on the statement" },
          type: { type: "string", enum: TX_TYPES },
          category: { type: "string", enum: CATEGORY_NAMES },
          notes: { type: "string" },
        },
      },
    },
    flagged_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "description", "amount", "reason"],
        properties: {
          date: { type: "string" },
          description: { type: "string" },
          amount: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
    recurring_subscriptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "amount", "frequency", "category"],
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
          frequency: { type: "string" },
          category: { type: "string", enum: CATEGORY_NAMES },
        },
      },
    },
    statement_period: {
      type: "object",
      additionalProperties: false,
      required: ["start", "end"],
      properties: { start: { type: "string" }, end: { type: "string" } },
    },
    notes: { type: "string", description: "Anything the preparer should know, e.g. pages that could not be read" },
  },
};

const SYSTEM_PROMPT = `You prepare bank-statement data for a U.S. sole proprietor's Schedule C (Form 1040) and profit and loss statement. A tax professional reviews your work before anything is filed.

Read every transaction in the statements provided and record each one exactly once:
- date as YYYY-MM-DD, the description as printed, and the amount as a positive number exactly as printed (no rounding, no sign).
- type: "income" for money the business earned; "expense" for business costs; "transfer" for movements between the owner's own accounts, credit card payments and loan principal; "personal" for clearly personal spending or owner draws/contributions; "needs_review" when you cannot tell.
- category: choose from the allowed list. Use "Cost of goods sold" only for inventory or materials resold or used in products. Business meals go to "Meals" at the full amount (the 50% limit is applied later). Use "Transfer between accounts", "Owner draw or personal" or "Needs review" to match those types.
- notes: a few words explaining any judgement call, otherwise an empty string.

Also list in flagged_items anything a preparer should double-check: large or unusual items, possible personal purchases at general retailers (Amazon, Walmart, Costco, Target), cash withdrawals, refunds, and deposits that might be loans or owner contributions rather than income. List recurring subscriptions in recurring_subscriptions.

Do not add up totals; the application calculates them. Do not invent transactions. If part of a document is unreadable, say so in notes.`;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    await requireUser(req);
    if (!Deno.env.get("ANTHROPIC_API_KEY")) {
      throw new HttpError(503, "The AI service isn't configured yet (ANTHROPIC_API_KEY is missing on the server).");
    }

    const body = await req.json().catch(() => ({}));
    const text = typeof body?.transactions_text === "string" ? body.transactions_text.trim() : "";
    const clientName = typeof body?.client_name === "string" ? body.client_name.slice(0, 200) : "";
    const pdfs: { name?: string; base64: string }[] = Array.isArray(body?.pdf_files) ? body.pdf_files : [];

    if (!text && pdfs.length === 0) throw new HttpError(400, "Upload a bank statement or paste transactions first.");
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, "That's too much text for one analysis. Split it into smaller batches (for example, one month at a time).");
    if (pdfs.length > MAX_PDFS) throw new HttpError(413, `Upload at most ${MAX_PDFS} PDFs at a time.`);
    let totalBase64 = 0;
    for (const pdf of pdfs) {
      if (typeof pdf?.base64 !== "string" || pdf.base64.length > MAX_PDF_BASE64_CHARS) {
        throw new HttpError(413, "Each PDF must be 15 MB or smaller.");
      }
      totalBase64 += pdf.base64.length;
    }
    if (totalBase64 > MAX_TOTAL_BASE64_CHARS) throw new HttpError(413, "These PDFs are too large together. Analyze them in smaller groups.");

    const content: Anthropic.Beta.BetaContentBlockParam[] = pdfs.map((pdf) => ({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdf.base64.replace(/\s/g, "") },
      title: pdf.name?.slice(0, 200) || "Bank statement",
    }));
    content.push({
      type: "text",
      text: [
        clientName ? `Client: ${clientName}` : "",
        pdfs.length ? `${pdfs.length} PDF statement(s) attached above.` : "",
        text ? `Statement data:\n${text}` : "",
        "Extract and classify every transaction.",
      ].filter(Boolean).join("\n\n"),
    });

    const message = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-06-01"],
        // If Claude Opus 5.5 declines (safety classifier), retry on Claude Opus 4.8.
        fallbacks: [{ model: "claude-opus-4-8" }],
        output_config: {
          effort: "low", // classification and extraction; keeps long statements fast
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      })
      .finalMessage();

    if (message.stop_reason === "refusal") {
      throw new HttpError(422, "The AI declined to analyze this document. Please check the file is a bank statement and try again.");
    }
    if (message.stop_reason === "max_tokens") {
      throw new HttpError(413, "These statements have too many transactions for one analysis. Split them into smaller periods (for example, one or two months at a time).");
    }

    const json = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new HttpError(502, "The AI returned an unreadable answer. Please try again.");
    }

    return jsonResponse(parsed);
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse({ error: error.message }, error.status);
    if (error instanceof Anthropic.RateLimitError) {
      return jsonResponse({ error: "The AI service is busy. Please try again in a minute." }, 429);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Anthropic authentication failed");
      return jsonResponse({ error: "The AI service isn't configured correctly (invalid API key)." }, 503);
    }
    if (error instanceof Anthropic.BadRequestError) {
      console.error("Anthropic bad request:", error.message);
      if (/credit balance/i.test(error.message)) {
        return jsonResponse({
          error: "The AI service account has run out of credit. Add credit at console.anthropic.com (Plans & Billing), then try again.",
        }, 402);
      }
      if (/pdf|document|password|encrypt/i.test(error.message)) {
        return jsonResponse({ error: "The AI couldn't read one of these files. Make sure PDFs aren't password-protected or scanned upside down." }, 422);
      }
      return jsonResponse({ error: `The AI service rejected the request: ${error.message.slice(0, 300)}` }, 422);
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${error.status}:`, error.message);
      return jsonResponse({ error: "The AI service had a problem. Please try again." }, 502);
    }
    console.error("schedule-c-analyze error:", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "Analysis failed. Please try again." }, 500);
  }
});
