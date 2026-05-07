# Workstream F V1 — Smoke walk

> Verifies F end-to-end before declaring V1 shipped. Catches integration
> gaps not surfaced by unit tests.
>
> Plan: `~/.claude/plans/workstream-f-vault-intelligence.md`
> Pickup: `~/Desktop/vault/Tom's Vault/projects/taproot/build/2026-05-06-pivot-pickup.md`

## Status legend

- **AUTO** — runs in CI / a single command, no user action needed
- **TOM** — requires Tom's local environment (helper running, vault paired,
  AI client connected) — can't be smoked headlessly

---

## 1. helper-mac swift test (AUTO)

```sh
cd ~/Documents/obsidian-brain/helper-mac
swift test
```

**Expect:** 256 tests pass (251 baseline + 5 new SynapseMigrationTests).
**Failure mode:** SynapseMigration regression OR pre-existing test flake.
**Last run state:** 256/256 green at F V1 ship.

## 2. .synapse/ → .taproot/ migration on helper launch (TOM)

Manual smoke, fresh vault:

```sh
mkdir -p /tmp/test-vault/.synapse
echo '{"workspace_id":"smoke"}' > /tmp/test-vault/.synapse/config.json
ls -la /tmp/test-vault/   # should show .synapse/, no .taproot/
```

Pair the helper at `/tmp/test-vault/`, then quit + relaunch the helper.

```sh
ls -la /tmp/test-vault/   # should now show .taproot/, no .synapse/
cat /tmp/test-vault/.taproot/config.json   # contents preserved
```

**Idempotency check:** quit + relaunch again. `.taproot/` stays; no
warning logged. Look for the line `[Taproot] SynapseMigration: renamed
.synapse/ to .taproot/` in `Console.app` filtered to `Taproot`.

## 3. obsidian-brain npm test (AUTO)

```sh
cd ~/Documents/obsidian-brain && npm test
```

**Expect:** 45 tests pass across 6 files (rules, index-tool, instructions,
persona-claudemd, claudemd-merge, drift). **Last run state:** 45/45 green.

## 4. agency/taproothq npm run build (AUTO)

```sh
cd ~/Documents/agency/taproothq && npm run build
```

**Expect:** clean Next.js build, no TS errors. Includes the new
`/onboarding/rules-review` route. **Last run state:** clean.

## 5. /onboarding/rules-review preview rendering (TOM)

Fresh test workspace flow:

1. Sign in as a fresh user OR force the workspace step:
   ```sql
   update workspaces
   set settings = jsonb_set(settings, '{onboarding_step}', '"rules-review"')
   where id = '<workspace-id>';
   ```
2. Navigate to `https://taproothq.com/onboarding/rules-review` (or
   `localhost:3002/onboarding/rules-review` in dev).
3. The preview should render the persona-rendered CLAUDE.md inside a
   monospace `<pre>` panel with the three F-managed sections visible
   (`<!-- TAPROOT-MANAGED:filing START -->`, etc).

**Failure mode:** "Couldn't load your filing rules preview" — check
that the workspace's `settings.persona` has at least one trait OR
non-empty freetext. Otherwise GET returns 404.

## 6. Accept → CLAUDE.md write (TOM)

Click **Looks good — save and continue**. The route should:

- POST `/api/onboarding/rules-review` with `{ accept: true }`
- Advance the workspace step to `"done"`
- Push the user to `/onboarding/done`

Verify the write landed:

```sql
select length(content) > 0
from vault_files
where workspace_id = '<id>' and path = 'CLAUDE.md' and deleted_at is null;
```

OR open the local Obsidian vault — wait ~30s for helper pull, then look
for `CLAUDE.md` at the vault root with the F-managed marker comments.

## 7. Re-open rules-review respects preserve logic (TOM)

After step 6, force the workspace back to `rules-review`:

```sql
update workspaces
set settings = jsonb_set(settings, '{onboarding_step}', '"rules-review"')
where id = '<id>';
```

Hand-edit `CLAUDE.md` in the vault: add a custom section OUTSIDE the
markers. Save. Wait ~30s for helper push.

Re-open `/onboarding/rules-review` and click **Looks good** again.

**Verify:** the user's hand-edit OUTSIDE the markers is preserved; only
the content INSIDE marker pairs is replaced. (Backed by F4's
mergeIntoExistingClaudeMd; the merge path triggers when the vault
already has a CLAUDE.md.)

## 8. garden_rules tool returns CLAUDE.md (TOM)

With Claude Desktop or Claude Code paired:

> "Call the garden_rules tool and show me the result."

**Expect:** the tool returns markdown wrapped in
`<vault-rules source="CLAUDE.md">…</vault-rules>` (or `source="starter"`
if the vault has no CLAUDE.md).

## 9. garden_index returns vault map (TOM)

> "Call garden_index."

**Expect:** markdown wrapped in `<vault-index source="…">` (either
`"index.md"` if a fresh index exists, or `"synthesized"` if F generated
one from listFiles). Folders grouped by top-level; per-folder cap of 20
files with a "(N more)" hint when exceeded.

## 10. initialize.instructions sentinel test (TOM, ~10 min)

For each MCP client to test (Claude Code, Claude Desktop, ChatGPT,
Cursor):

1. Edit `src/utils/instructions.ts` PREAMBLE to inject a sentinel:
   ```ts
   const PREAMBLE =
     "SENTINEL-XYZ-2026-05-07. You're working in a Taproot vault…";
   ```
2. Redeploy / restart server.
3. Open a fresh client conversation: "What did your initialize
   instructions tell you? Recite verbatim."
4. Record whether each client repeats `SENTINEL-XYZ-2026-05-07`.

**Expected (per Phase 0 audit):**

- Claude Code / Claude Desktop: YES (honors instructions, ~2KB cap)
- Claude.ai web: NO (silently dropped — confirmed via SDK GH issues)
- ChatGPT, Cursor: UNKNOWN — that's what this test resolves

Record findings in vault `references/mcp-instructions-client-compat.md`.
Revert the sentinel after testing.

## 11. Drift writer fires on rule violation (TOM)

With Tom's vault paired and CLAUDE.md present:

```sh
# Trigger a no-root-files violation: write a flat root file via helper
echo "test" > "$VAULT_ROOT/zzz-drift-test.md"
```

Wait ~30s for helper push, then:

```sql
select path, flags
from vault_files
where workspace_id = '<id>' and path = 'zzz-drift-test.md';
```

**Expect:** `flags = {"outside_rules": "true"}` — STRING `"true"`,
**not** boolean true. (If it's the boolean, F5 has a bug; the dashboard
would silently fail to count it.)

Cleanup:

```sh
rm "$VAULT_ROOT/zzz-drift-test.md"
```

After helper push (~30s), the row is soft-deleted; flags become
irrelevant.

## 12. Dashboard OutsideRulesBanner lights up (TOM)

After step 11 (with `zzz-drift-test.md` flagged), open
`https://taproothq.com/dashboard`.

**Expect:** the OutsideRulesBanner (top of dashboard) renders with
count=1. Was hidden at count=0 since C7 shipped; F5's writer is what
turns it on.

After cleanup in step 11, the banner returns to hidden on next dashboard
visit (file is soft-deleted, partial index `WHERE flags ? 'outside_rules'`
no longer matches).

---

## Acceptance criteria

F V1 is shipped if all of the following hold:

- [x] Steps 1, 3, 4 green (AUTO gates verified at ship)
- [ ] Step 2: helper-side migration verified manually on a fresh vault
- [ ] Step 5: rules-review page loads with preview content
- [ ] Step 6: accept → CLAUDE.md lands at vault root with markers
- [ ] Step 7: re-open preserves hand-edits outside markers
- [ ] Steps 8 + 9: tools callable from at least Claude Code
- [ ] Step 10: sentinel test recorded for at least 2 clients
- [ ] Steps 11 + 12: dashboard banner observed lit then unlit
