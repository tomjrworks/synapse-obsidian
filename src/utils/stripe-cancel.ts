import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getSubscription } from "../api/subscription.js";

export type CancelReason = "no_sub" | "already_canceled" | "ok";

export interface CancelResult {
  canceled: boolean;
  reason: CancelReason;
}

// Shared helper for PR #5: cancels the workspace's Stripe subscription at
// period end (preserving paid access through the period already paid for).
// Used by /api/leave AND DELETE /api/account so the Stripe-cancel semantics
// stay in one place. Throws on Stripe API error so callers can fail-closed
// (return 500 without nuking).
//
// Returns:
//   { canceled: false, reason: "no_sub" }            — no row OR no stripe_subscription_id
//   { canceled: false, reason: "already_canceled" } — sub.status === "canceled"
//   { canceled: true,  reason: "ok" }                — successfully called stripe.subscriptions.update
export async function cancelWorkspaceSubscription(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<CancelResult> {
  const sub = await getSubscription(sb, workspaceId);
  if (!sub || !sub.stripe_subscription_id) {
    return { canceled: false, reason: "no_sub" };
  }
  if (sub.status === "canceled") {
    return { canceled: false, reason: "already_canceled" };
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const stripe = new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
  });
  return { canceled: true, reason: "ok" };
}
