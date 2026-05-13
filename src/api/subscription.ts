import type { SupabaseClient } from "@supabase/supabase-js";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "paused"
  | "grandfathered";

export interface WorkspaceSubscription {
  workspace_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  grandfathered_at: string | null;
  trial_warning_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getSubscription(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceSubscription | null> {
  const { data, error } = await sb
    .from("workspace_subscriptions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data as WorkspaceSubscription | null;
}

// Returns true for: active, grandfathered, or trialing with trial_ends_at in the future.
// The status column never auto-updates in Postgres — must check trial_ends_at at runtime.
export function isSubscriptionActive(sub: WorkspaceSubscription): boolean {
  if (sub.status === "active" || sub.status === "grandfathered") return true;
  if (sub.status === "trialing" && sub.trial_ends_at != null) {
    return new Date(sub.trial_ends_at) > new Date();
  }
  return false;
}

// Returns days remaining for trialing subs; negative if expired; null if not trialing.
export function getDaysRemaining(sub: WorkspaceSubscription): number | null {
  if (sub.status !== "trialing" || sub.trial_ends_at == null) return null;
  const msLeft = new Date(sub.trial_ends_at).getTime() - Date.now();
  return Math.ceil(msLeft / (1000 * 60 * 60 * 24));
}

// If no workspace_subscriptions row exists, synthesize a trialing sub from
// workspaces.created_at — safety net for workspaces created during the
// migration window before the RPC update applied.
export async function getSubscriptionFallback(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceSubscription> {
  const existing = await getSubscription(sb, workspaceId);
  if (existing) return existing;

  // Synthesize from workspace.created_at
  const { data: ws, error } = await sb
    .from("workspaces")
    .select("created_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;

  const createdAt = ws?.created_at ?? new Date().toISOString();
  const trialEndsAt = new Date(
    new Date(createdAt).getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  return {
    workspace_id: workspaceId,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    status: "trialing",
    trial_ends_at: trialEndsAt,
    current_period_end: null,
    canceled_at: null,
    grandfathered_at: null,
    trial_warning_sent_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}
