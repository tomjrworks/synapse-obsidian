import { Router } from "express";
import Stripe from "stripe";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { respondError } from "./respond-error.js";
import {
  getSubscription,
  getDaysRemaining,
  type WorkspaceSubscription,
} from "./subscription.js";

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
}

export interface BillingStatus {
  status: WorkspaceSubscription["status"];
  trial_ends_at: string | null;
  days_remaining: number | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  grandfathered: boolean;
}

export function billingRouter(): Router {
  const router = Router();

  // GET /api/billing — current subscription state
  router.get(
    "/billing",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();
      const sub = await getSubscription(sb, membership.workspaceId);

      if (!sub) {
        // No row yet — treat as early trialing (migration window safety net)
        res.json({
          status: "trialing",
          trial_ends_at: null,
          days_remaining: null,
          current_period_end: null,
          stripe_customer_id: null,
          grandfathered: false,
        } satisfies BillingStatus);
        return;
      }

      res.json({
        status: sub.status,
        trial_ends_at: sub.trial_ends_at,
        days_remaining: getDaysRemaining(sub),
        current_period_end: sub.current_period_end,
        stripe_customer_id: sub.stripe_customer_id,
        grandfathered: sub.status === "grandfathered",
      } satisfies BillingStatus);
    }),
  );

  // POST /api/billing/checkout — create Stripe checkout session
  router.post(
    "/billing/checkout",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const { interval } = req.body as { interval?: "month" | "year" };

      if (interval !== "month" && interval !== "year") {
        respondError(
          res,
          400,
          "invalid_interval",
          new Error("interval must be month or year"),
          {
            logPrefix: "billing",
          },
        );
        return;
      }

      const priceId =
        interval === "month"
          ? process.env.STRIPE_MONTHLY_PRICE_ID
          : process.env.STRIPE_ANNUAL_PRICE_ID;

      if (!priceId) {
        respondError(
          res,
          500,
          "stripe_not_configured",
          new Error(`STRIPE_${interval.toUpperCase()}_PRICE_ID not set`),
          {
            logPrefix: "billing",
          },
        );
        return;
      }

      const siteUrl = process.env.SITE_URL ?? "https://taproothq.com";
      const stripe = stripeClient();
      const sb = supabaseService();

      // Get or create Stripe customer
      let sub = await getSubscription(sb, membership.workspaceId);
      let stripeCustomerId = sub?.stripe_customer_id ?? null;

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          metadata: { workspace_id: membership.workspaceId },
        });
        stripeCustomerId = customer.id;

        // Persist customer ID immediately so a second click finds it
        await sb
          .from("workspace_subscriptions")
          .upsert({
            workspace_id: membership.workspaceId,
            stripe_customer_id: stripeCustomerId,
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", membership.workspaceId);
      }

      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${siteUrl}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/dashboard/settings`,
        metadata: { workspace_id: membership.workspaceId },
      });

      res.json({ url: session.url });
    }),
  );

  // POST /api/billing/portal — create Stripe customer portal session
  router.post(
    "/billing/portal",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();
      const sub = await getSubscription(sb, membership.workspaceId);

      if (!sub?.stripe_customer_id) {
        respondError(
          res,
          400,
          "no_billing_account",
          new Error("workspace has no stripe_customer_id"),
          {
            logPrefix: "billing",
          },
        );
        return;
      }

      const siteUrl = process.env.SITE_URL ?? "https://taproothq.com";
      const stripe = stripeClient();

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        return_url: `${siteUrl}/dashboard/settings`,
      });

      res.json({ url: portalSession.url });
    }),
  );

  return router;
}
