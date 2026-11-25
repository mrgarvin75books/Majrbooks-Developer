// Run: deno test --allow-env supabase/functions/_shared/email/
// Exercises sendTemplatedEmail against a recording fake database client and a
// stubbed fetch, so it checks exactly what would be posted to Resend.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { sendTemplatedEmail } from "./send.ts";
import { TEMPLATES } from "./templates.ts";

type Row = Record<string, unknown>;

function fakeDb(opts: { override?: Row | null; claimReturns?: string | null } = {}) {
  const calls: { op: string; table?: string; values?: unknown; args?: unknown }[] = [];
  const builder = (table: string) => {
    let op = "select";
    let values: unknown;
    const chain: Record<string, unknown> = {};
    const finish = () => {
      calls.push({ op, table, values });
      return Promise.resolve({ data: op === "select" ? opts.override ?? null : null, error: null });
    };
    for (const m of ["select", "eq", "is", "in", "gte"]) chain[m] = () => chain;
    chain.update = (v: unknown) => ((op = "update"), (values = v), chain);
    chain.insert = (v: unknown) => ((op = "insert"), (values = v), finish());
    chain.maybeSingle = finish;
    chain.then = (res: (v: unknown) => unknown) => finish().then(res);
    return chain;
  };
  const db = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: unknown) => {
      calls.push({ op: "rpc", args: { name, ...(args as object) } });
      return Promise.resolve({ data: opts.claimReturns === undefined ? "log-123" : opts.claimReturns, error: null });
    },
  };
  // deno-lint-ignore no-explicit-any
  return { db: db as any, calls };
}

function stubFetch(responses: { status: number; body: unknown }[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(".png")) {
      return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }));
    }
    requests.push({ url, init: init ?? {} });
    const r = responses[Math.min(requests.length - 1, responses.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

const base = {
  templateKey: "password_reset" as const,
  to: "Jordan.Ellis@example.com",
  variables: TEMPLATES.password_reset.sample,
  recipientUserId: "user-1",
  dedupeKey: "password_reset:tok-1",
  dedupeWindowSeconds: null,
  context: { user_id: "user-1" },
};

Deno.test({
  name: "sends through Resend with the right payload, headers and inline logo, then logs success",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.set("RESEND_API_KEY", "re_test_key_123456");
    const { db, calls } = fakeDb();
    const f = stubFetch([{ status: 200, body: { id: "resend-abc" } }]);
    try {
      const res = await sendTemplatedEmail(db, base);
      assertEquals(res, { status: "sent", logId: "log-123", resendId: "resend-abc" });

      assertEquals(f.requests.length, 1);
      const req = f.requests[0];
      assertEquals(req.url, "https://api.resend.com/emails");
      const headers = req.init.headers as Record<string, string>;
      assertEquals(headers.Authorization, "Bearer re_test_key_123456");
      assertEquals(headers["Idempotency-Key"], "log-123");
      const payload = JSON.parse(String(req.init.body));
      assertEquals(payload.from, "MAJR Books <support@majrbooks.com>");
      assertEquals(payload.to, ["Jordan.Ellis@example.com"]);
      assertEquals(payload.subject, "Password Reset Request – Secure Your Account");
      assertEquals(payload.reply_to, "support@prm3tax.com");
      assertStringIncludes(payload.html, 'src="cid:majr-logo"');
      assertStringIncludes(payload.html, "https://majrbooks.com/reset-password?token=sample-token");
      assertStringIncludes(payload.text, "https://majrbooks.com/reset-password?token=sample-token");
      assertEquals(payload.attachments[0].content_id, "majr-logo");
      assertEquals(payload.tags, [{ name: "template", value: "password_reset" }]);

      const claim = calls.find((c) => c.op === "rpc")!.args as Record<string, unknown>;
      assertEquals(claim.name, "claim_email_send");
      assertEquals(claim.p_dedupe_key, "password_reset:tok-1");
      assertEquals(claim.p_window_seconds, null);
      // Nothing secret goes into the log row.
      assertFalse(JSON.stringify(claim).includes("token=sample-token"));

      const update = calls.find((c) => c.op === "update" && c.table === "email_logs")!.values as Row;
      assertEquals(update.status, "sent");
      assertEquals(update.resend_id, "resend-abc");
    } finally {
      f.restore();
    }
  },
});

Deno.test({
  name: "retries server errors, then records a scrubbed failure",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.set("RESEND_API_KEY", "re_test_key_123456");
    const { db, calls } = fakeDb();
    const f = stubFetch([{ status: 500, body: { message: "boom https://majrbooks.com/reset-password?token=secret" } }]);
    try {
      const res = await sendTemplatedEmail(db, base);
      assertEquals(res.status, "failed");
      assertEquals(f.requests.length, 3, "three attempts on 5xx");
      const update = calls.find((c) => c.op === "update")!.values as Row;
      assertEquals(update.status, "failed");
      assertEquals(update.attempts, 3);
      assertFalse(String(update.error_message).includes("token=secret"));
    } finally {
      f.restore();
    }
  },
});

Deno.test({
  name: "does not retry a rejected request (e.g. unverified domain)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.set("RESEND_API_KEY", "re_test_key_123456");
    const { db } = fakeDb();
    const f = stubFetch([{ status: 403, body: { message: "The majrbooks.com domain is not verified" } }]);
    try {
      const res = await sendTemplatedEmail(db, base);
      assertEquals(res.status, "failed");
      assertEquals(f.requests.length, 1);
      assertStringIncludes(res.error!, "not verified");
    } finally {
      f.restore();
    }
  },
});

Deno.test({
  name: "duplicate claims and disabled templates never call Resend",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.set("RESEND_API_KEY", "re_test_key_123456");
    const f = stubFetch([{ status: 200, body: { id: "x" } }]);
    try {
      const dup = fakeDb({ claimReturns: null });
      assertEquals((await sendTemplatedEmail(dup.db, base)).status, "duplicate");

      const off = fakeDb({ override: { template_key: "password_reset", enabled: false } });
      assertEquals((await sendTemplatedEmail(off.db, base)).status, "disabled");
      const skipped = off.calls.find((c) => c.op === "insert")!.values as Row;
      assertEquals(skipped.status, "skipped");

      assertEquals(f.requests.length, 0);
    } finally {
      f.restore();
    }
  },
});

Deno.test({
  name: "admin wording overrides are used when sending",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.set("RESEND_API_KEY", "re_test_key_123456");
    const { db } = fakeDb({ override: { template_key: "password_reset", enabled: true, subject: "Reset for {{first_name}}" } });
    const f = stubFetch([{ status: 200, body: { id: "x" } }]);
    try {
      await sendTemplatedEmail(db, base);
      assertEquals(JSON.parse(String(f.requests[0].init.body)).subject, "Reset for Jordan");
    } finally {
      f.restore();
    }
  },
});

Deno.test({
  name: "a missing API key is logged as a failure, not thrown",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.delete("RESEND_API_KEY");
    const { db, calls } = fakeDb();
    const res = await sendTemplatedEmail(db, base);
    assertEquals(res.status, "failed");
    assert(String((calls.find((c) => c.op === "update")!.values as Row).error_message).includes("RESEND_API_KEY"));
  },
});
