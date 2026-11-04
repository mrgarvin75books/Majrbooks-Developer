import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, errorResponse, requireUser, serviceClient } from "../_shared/security.ts";

const BUCKETS = [
  { name: "bank-statements", public: false },
  { name: "client-documents", public: false },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Only signed-in users; bucket names are fixed and creation is idempotent.
    await requireUser(req);
    const supabase = serviceClient();

    const results: Record<string, string> = {};

    for (const bucket of BUCKETS) {
      // Check if bucket already exists
      const { data: existing } = await supabase.storage.getBucket(bucket.name);
      if (existing) {
        results[bucket.name] = "exists";
        continue;
      }

      // Create it
      const { error } = await supabase.storage.createBucket(bucket.name, {
        public: bucket.public,
        fileSizeLimit: 52428800, // 50 MB
      });

      results[bucket.name] = error ? `error: ${error.message}` : "created";
    }

    return new Response(JSON.stringify({ ok: true, buckets: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return errorResponse(e);
  }
});
