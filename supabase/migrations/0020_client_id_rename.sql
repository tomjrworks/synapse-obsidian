-- 0020: rename microsoft-copilot -> copilot-vscode in connected_clients arrays.
--   These are different products: SITE intent is GitHub Copilot in VS Code,
--   PRODUCT had Microsoft Copilot (M365). Aligning on copilot-vscode.
-- Idempotent: WHERE clause excludes already-migrated rows.

UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{connected_clients}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN elem = '"microsoft-copilot"'::jsonb THEN '"copilot-vscode"'::jsonb
        ELSE elem
      END
    )
    FROM jsonb_array_elements(settings->'connected_clients') AS elem
  )
)
WHERE settings->'connected_clients' @> '["microsoft-copilot"]'::jsonb;
