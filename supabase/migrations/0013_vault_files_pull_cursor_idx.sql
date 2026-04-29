-- Stage 1 T11.4 — pull cursor covering index
-- Used exclusively by GET /api/sync/pull. Cursor query is
--   WHERE workspace_id = $1
--     AND ((modified_at > $2) OR (modified_at = $2 AND id > $3))
--   ORDER BY modified_at ASC, id ASC
--   LIMIT $4
-- Tuple comparison drives ordered-index seek; the (workspace_id, modified_at, id)
-- ordering means a single index scan satisfies the predicate + the ORDER BY +
-- the LIMIT.
--
-- NOT partial: cursor must visit deleted rows so soft-delete tombstones
-- propagate to the helper. T11.4 IQ-1 fix bumps `modified_at` on soft-delete
-- (supabase-mirror.ts delete()) so deleted_at-bearing rows advance the cursor.
--
-- Pre-existing `vault_files_workspace_modified_idx` (migration 0003) stays —
-- it's `(workspace_id, modified_at DESC) WHERE deleted_at IS NULL` and serves
-- `recentFiles` (garden_recent at src/tools/vault.ts). Different sort
-- direction + different where clause = different access plan; both coexist.

create index if not exists vault_files_pull_cursor_idx
  on vault_files(workspace_id, modified_at asc, id asc);
