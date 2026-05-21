import type { Request, Response } from "express";
import Stripe from "stripe";
import { supabaseService } from "./supabase.js";
import { respondError } from "./respond-error.js";

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
}

// Map Stripe subscription status to our enum.
// Stripe statuses: active, past_due, canceled, incomplete, incomplete_expired,
// trialing, paused, unpaid. We only need the ones Stripe sends us.
function mapStripeStatus(
  stripeStatus: string,
): "active" | "past_due" | "canceled" | "trialing" | "paused" {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
      return "past_due";
    case "canceled":
      return "canceled";
    case "trialing":
      return "trialing";
    case "paused":
      return "paused";
    default:
      return "past_due";
  }
}

async function getWorkspaceIdByCustomer(
  customerId: string,
): Promise<string | null> {
  const { data, error } = await supabaseService()
    .from("workspace_subscriptions")
    .select("workspace_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) {
    console.error("[stripe-webhook] customer lookup error:", error.message);
    return null;
  }
  return data?.workspace_id ?? null;
}

export async function stripeWebhookHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set");
    res.status(500).json({ error: "webhook_not_configured" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).json({ error: "missing_stripe_signature" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(
      req.body as Buffer,
      sig,
      webhookSecret,
    );
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err);
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  const sb = supabaseService();

  // C3: idempotency — Stripe redelivers events (its own retries + our C4
  // non-2xx retries). Skip any event already handled. An event is recorded in
  // processed_webhook_events only AFTER its handler succeeds (below), so a
  // failed event is left unrecorded and a Stripe retry reprocesses it.
  const { data: alreadyProcessed } = await sb
    .from("processed_webhook_events")
    .select("event_id")
    .eq("event_id", event.id)
    .maybeSingle();
  if (alreadyProcessed) {
    res.status(200).json({ received: true, deduped: true });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const workspaceId = session.metadata?.workspace_id ?? null;
        if (!workspaceId) {
          console.warn(
            "[stripe-webhook] checkout.session.completed missing workspace_id in metadata",
          );
          break;
        }

        // Retrieve the actual subscription to get its real status (not just 'active')
        const stripe = stripeClient();
        let subStatus: ReturnType<typeof mapStripeStatus> = "active";
        let currentPeriodEnd: string | null = null;

        if (session.subscription) {
          const stripeSub = await stripe.subscriptions.retrieve(
            session.subscription as string,
          );
          subStatus = mapStripeStatus(stripeSub.status);
          // v22: current_period_end moved to SubscriptionItem
          const periodEnd = stripeSub.items.data[0]?.current_period_end;
          if (periodEnd) {
            currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
          }
        }

        const { error: upsertErr } = await sb
          .from("workspace_subscriptions")
          .upsert({
            workspace_id: workspaceId,
            stripe_customer_id: session.customer as string | null,
            stripe_subscription_id: session.subscription as string | null,
            status: subStatus,
            current_period_end: currentPeriodEnd,
            updated_at: new Date().toISOString(),
          });
        if (upsertErr) {
          throw new Error(
            `workspace_subscriptions upsert failed for ${workspaceId} on ${event.type}: ${upsertErr.message}`,
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const workspaceId = await getWorkspaceIdByCustomer(
          sub.customer as string,
        );
        if (!workspaceId) break;

        // v22: current_period_end moved to SubscriptionItem
        const periodEnd = sub.items.data[0]?.current_period_end;
        const { error: updateErr } = await sb
          .from("workspace_subscriptions")
          .update({
            status: mapStripeStatus(sub.status),
            current_period_end: periodEnd
              ? new Date(periodEnd * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", workspaceId);
        if (updateErr) {
          throw new Error(
            `workspace_subscriptions update failed for ${workspaceId} on ${event.type}: ${updateErr.message}`,
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const workspaceId = await getWorkspaceIdByCustomer(
          sub.customer as string,
        );
        if (!workspaceId) break;

        const { error: updateErr } = await sb
          .from("workspace_subscriptions")
          .update({
            status: "canceled",
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", workspaceId);
        if (updateErr) {
          throw new Error(
            `workspace_subscriptions update failed for ${workspaceId} on ${event.type}: ${updateErr.message}`,
          );
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const workspaceId = await getWorkspaceIdByCustomer(
          invoice.customer as string,
        );
        if (!workspaceId) break;

        const { error: updateErr } = await sb
          .from("workspace_subscriptions")
          .update({
            status: "past_due",
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", workspaceId);
        if (updateErr) {
          throw new Error(
            `workspace_subscriptions update failed for ${workspaceId} on ${event.type}: ${updateErr.message}`,
          );
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const workspaceId = await getWorkspaceIdByCustomer(
          invoice.customer as string,
        );
        if (!workspaceId) break;

        // v22: invoice.subscription moved to invoice.parent.subscription_details.subscription
        let currentPeriodEnd: string | null = null;
        const subRef =
          invoice.parent?.subscription_details?.subscription ?? null;
        if (subRef) {
          const stripeSub = await stripeClient().subscriptions.retrieve(
            typeof subRef === "string" ? subRef : subRef.id,
          );
          // v22: current_period_end is per SubscriptionItem
          const periodEnd = stripeSub.items.data[0]?.current_period_end;
          if (periodEnd) {
            currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
          }
        }

        const { error: updateErr } = await sb
          .from("workspace_subscriptions")
          .update({
            status: "active",
            current_period_end: currentPeriodEnd,
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", workspaceId);
        if (updateErr) {
          throw new Error(
            `workspace_subscriptions update failed for ${workspaceId} on ${event.type}: ${updateErr.message}`,
          );
        }
        break;
      }

      default:
        // Unhandled event — recorded as processed below so a redelivery is
        // skipped rather than reprocessed.
        break;
    }
  } catch (err) {
    // C4: return non-2xx so Stripe retries — silently dropping a
    // subscription.deleted / payment_failed event to a transient DB error is a
    // real billing bug. Safe to retry: the event was not recorded below, and
    // C3's dedupe keeps a later successful reprocess idempotent. respondError
    // also fires the Discord 5xx alert.
    respondError(res, 500, "stripe_webhook_error", err, {
      logPrefix: "stripe-webhook",
    });
    return;
  }

  // S98: dedupe write lives OUTSIDE the try/catch — only reached on full
  // branch-write success. Prior shape (dedupe inside try) was structurally
  // ambiguous; keeping it after the catch makes "only mark processed when
  // every write succeeded" explicit. ignoreDuplicates handles the rare
  // concurrent-delivery race (two deliveries both pass the dedupe SELECT)
  // without a PK-conflict error.
  const { error: dedupeErr } = await sb
    .from("processed_webhook_events")
    .upsert(
      { event_id: event.id, event_type: event.type },
      { onConflict: "event_id", ignoreDuplicates: true },
    );
  if (dedupeErr) {
    // Idempotency-table write failed — return 500 so Stripe retries.
    // Reprocess on retry is safe (all branch writes are upserts/updates
    // keyed on workspace_id).
    respondError(
      res,
      500,
      "stripe_webhook_dedupe_failed",
      new Error(dedupeErr.message),
      { logPrefix: "stripe-webhook" },
    );
    return;
  }

  res.status(200).json({ received: true });
}
