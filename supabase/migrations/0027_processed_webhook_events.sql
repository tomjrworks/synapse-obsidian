-- C3: Stripe webhook event idempotency / dedupe.
--
-- Stripe redelivers events — its own network retries, and (after C4) our own
-- non-2xx-on-error retries. Without a dedupe guard a redelivered or out-of-
-- order event can briefly overwrite newer workspace_subscriptions state with
-- an older snapshot before self-healing on the next event.
--
-- The webhook handler records an event_id here only AFTER the event is handled
-- successfully. A failed handler leaves no row, so a Stripe retry reprocesses
-- it (intended — pairs with C4's non-2xx-on-error change).

create table processed_webhook_events (
  event_id      text        primary key,
  event_type    text,
  processed_at  timestamptz not null default now()
);

-- RLS — service role only. The webhook handler uses supabaseService(), which
-- bypasses RLS; no other role should ever touch this table. Deny-by-default
-- (RLS enabled, no permissive policies) matches workspace_subscriptions and
-- every other table.
alter table processed_webhook_events enable row level security;
-- No permissive policies added.
