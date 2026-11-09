import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Check if user is an admin - admins bypass subscription checks
    const { data: roleData, error: roleError } = await supabaseClient
      .from('app_user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleError && roleData) {
      logStep("Admin user detected - bypassing subscription check", { userId: user.id });
      return new Response(JSON.stringify({
        subscribed: true,
        product_id: "admin_access",
        subscription_end: null,
        is_trial: false,
        is_stripe_trial: false,
        trial_ends_at: null,
        is_admin: true,
        can_cancel: false
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const json = (body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });

    // App-managed 14-day trial (profiles.trial_ends_at). Used only when the
    // user has no active Stripe subscription, so that paying during the trial
    // is reflected immediately.
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("trial_ends_at")
      .eq("id", user.id)
      .maybeSingle();
    const appTrialActive = !!profile?.trial_ends_at && new Date(profile.trial_ends_at) > new Date();

    const notSubscribed = () =>
      appTrialActive
        ? json({
            subscribed: true,
            product_id: "trial",
            subscription_end: profile!.trial_ends_at,
            is_trial: true,
            is_stripe_trial: false,
            trial_ends_at: profile!.trial_ends_at,
            is_admin: false,
            can_cancel: false,
          })
        : json({
            subscribed: false,
            product_id: null,
            subscription_end: null,
            is_trial: false,
            is_stripe_trial: false,
            trial_ends_at: null,
            is_admin: false,
            can_cancel: false,
          });

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      logStep("STRIPE_SECRET_KEY not configured");
      return notSubscribed();
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (customers.data.length === 0) {
      logStep("No Stripe customer found");
      return notSubscribed();
    }

    const customerId = customers.data[0].id;
    const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
    const subscription = subscriptions.data.find((sub: Stripe.Subscription) =>
      sub.status === "active" || sub.status === "trialing"
    );
    if (!subscription) {
      logStep("No active or trialing subscription found");
      return notSubscribed();
    }

    const isTrialing = subscription.status === "trialing";
    const firstItem = subscription.items?.data?.[0];
    // In API version 2025-08-27.basil, current_period_end lives on the
    // subscription item, not the subscription. Support both shapes.
    // deno-lint-ignore no-explicit-any
    const periodEndUnix = (firstItem as any)?.current_period_end ?? (subscription as any).current_period_end;
    const subscriptionEnd = typeof periodEndUnix === "number" ? new Date(periodEndUnix * 1000).toISOString() : null;
    const price = firstItem?.price;
    const productId = typeof price?.product === "string" ? price.product : price?.product?.id ?? null;
    const trialEndsAt = isTrialing && subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null;

    logStep("Subscription found", { subscriptionId: subscription.id, status: subscription.status, productId });

    return json({
      subscribed: true,
      product_id: productId,
      subscription_end: isTrialing ? trialEndsAt : subscriptionEnd,
      is_trial: isTrialing,
      is_stripe_trial: isTrialing,
      trial_ends_at: trialEndsAt,
      is_admin: false,
      can_cancel: true, // User can always cancel via customer portal
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    const status = /auth|token|authorization/i.test(errorMessage) ? 401 : 500;
    return new Response(JSON.stringify({ error: status === 401 ? "Authentication required" : "Subscription check failed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status,
    });
  }
});
