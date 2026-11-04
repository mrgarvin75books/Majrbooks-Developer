// Shared authentication / authorization helpers for edge functions.
//
// Every function that uses the service-role client MUST first establish who
// the caller is with one of these helpers, and then check that the caller owns
// the rows it is about to touch. The service-role client bypasses RLS.

import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Convert any thrown value into a JSON error response (never leaks stack traces). */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("Unhandled error:", message);
  return jsonResponse({ error: "Internal server error" }, 500);
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when the request was made by trusted server code: either another edge
 * function using the service-role key, or a scheduler presenting CRON_SECRET
 * in the `x-cron-secret` header.
 */
export function isInternalRequest(req: Request): boolean {
  const token = bearerToken(req);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (token && serviceKey && safeEqual(token, serviceKey)) return true;

  const cronSecret = Deno.env.get("CRON_SECRET");
  const presented = req.headers.get("x-cron-secret");
  if (cronSecret && presented && safeEqual(presented, cronSecret)) return true;

  return false;
}

/** Returns the signed-in user for this request, or null (anon key / no token / invalid token). */
export async function getAuthUser(req: Request): Promise<User | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/** Like getAuthUser but throws 401 when there is no signed-in user. */
export async function requireUser(req: Request): Promise<User> {
  const user = await getAuthUser(req);
  if (!user) throw new HttpError(401, "Authentication required");
  return user;
}

/**
 * Resolves the "books owner" a user acts for: the owner_id of an active
 * team_members row, else the user themself. Mirrors src/lib/scopeOwner.ts.
 */
export async function getScopeOwnerId(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin
    .from("team_members")
    .select("owner_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  return data?.owner_id ?? userId;
}

/** Escape a value for safe interpolation into HTML email bodies. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(400, `${field} must be a valid id`);
  }
  return value;
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
export function assertEmail(value: unknown, field = "email"): string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL_RE.test(value.trim())) {
    throw new HttpError(400, `${field} must be a valid email address`);
  }
  return value.trim();
}

/**
 * Only allow fetching files that live in this project's Supabase Storage.
 * Prevents server-side request forgery through user-supplied URLs.
 */
export function assertProjectStorageUrl(value: unknown, field: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `${field} must be a URL`);
  }
  const base = new URL(Deno.env.get("SUPABASE_URL")!);
  if (url.protocol !== "https:" || url.host !== base.host || !url.pathname.startsWith("/storage/v1/object/")) {
    throw new HttpError(400, `${field} must point to this project's file storage`);
  }
  return url.toString();
}
