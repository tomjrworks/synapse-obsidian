-- Taproot Billing — workspace_subscriptions table + backfill + RPC update
--
-- All three changes land in one migration to avoid a race condition:
-- if the RPC update were in a separate 0026, workspaces created after 0025
-- applies but before 0026 would have no subscription row, causing
-- requireSubscription to 402 brand-new users immediately.
--
-- Safety net: getSubscriptionFallback in subscription.ts synthesizes a
-- trialing row from workspaces.created_at if no row exists — so even
-- workspaces that slip through the window are never hard-blocked.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Enum
-- ──────────────────────────────────────────────────────────────────────────

create type subscription_status as enum (
  'trialing',
  'active',
  'past_due',
  'canceled',
  'paused',
  'grandfathered'
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Table
-- ──────────────────────────────────────────────────────────────────────────

create table workspace_subscriptions (
  workspace_id            uuid        primary key
                                      references workspaces(id) on delete cascade,
  stripe_customer_id      text        unique,
  stripe_subscription_id  text        unique,
  status                  subscription_status not null default 'trialing',
  trial_ends_at           timestamptz,
  current_period_end      timestamptz,
  canceled_at             timestamptz,
  grandfathered_at        timestamptz,
  trial_warning_sent_at   timestamptz,   -- set when nudge email fires; prevents re-send
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. RLS — service role only (no direct client reads)
-- ──────────────────────────────────────────────────────────────────────────

alter table workspace_subscriptions enable row level security;
-- No permissive policies added — service role bypasses RLS

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Backfill: all existing non-deleted workspaces → grandfathered
-- ──────────────────────────────────────────────────────────────────────────

insert into workspace_subscriptions (workspace_id, status, grandfathered_at)
select id, 'grandfathered', now()
from workspaces
where deleted_at is null;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Update RPC — new workspaces get a trialing subscription row
--
-- Keeps the same arg signature (uuid, uuid, text, bytea) and return type
-- (uuid) as migration 0021. CREATE OR REPLACE is safe — no DROP needed.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.create_workspace_for_new_user(
  p_workspace_id   uuid,
  p_user_id        uuid,
  p_workspace_name text,
  p_wrapped_dek    bytea
) returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
as $$
begin
  insert into workspaces (id, name, owner_user_id, workspace_type, settings)
    values (
      p_workspace_id,
      p_workspace_name,
      p_user_id,
      'personal',
      '{"onboarding_step": "persona", "persona": null, "connected_clients": []}'::jsonb
    );

  insert into workspace_members (workspace_id, user_id, role, joined_at)
    values (p_workspace_id, p_user_id, 'owner', now());

  insert into tenant_keys (workspace_id, wrapped_dek)
    values (p_workspace_id, p_wrapped_dek);

  -- New: every fresh workspace starts with a 30-day trial
  insert into workspace_subscriptions (workspace_id, status, trial_ends_at)
    values (p_workspace_id, 'trialing', now() + interval '30 days');

  return p_workspace_id;
end;
$$;
