# KEK rotation procedure

The Key Encryption Key (KEK) wraps every workspace's per-tenant Data Encryption Key (DEK). KEK rotation re-wraps every existing DEK under a new KEK, leaving ciphertext in Supabase Storage untouched. Plaintext is never re-encrypted; only the wrapping keys change.

**Trigger this when:**

- Suspected KEK leak (CI logs, screenshot, terminal share, accidental commit).
- Annual rotation (best practice; calendar reminder in October).
- Personnel change (former contributor with possible KEK access).
- Hardware change for the machine that held a backup copy.

**Time required:** ~10 minutes for <1000 workspaces. Linear in workspace count.

## Pre-flight

1. Confirm both KEK backups still exist and match (1Password copy + printed paper copy). If they don't match, **stop** — figure out which is canonical before rotating.
2. Confirm production traffic is light (off-peak). The rotation script holds a brief lock on `tenant_keys` while updating each row.
3. Tag a release before rotating in case you need to roll back: `git tag pre-rotate-$(date +%Y-%m-%d)`.

## Rotation steps

### 1. Generate a new KEK

```bash
openssl rand -hex 32
```

64-char lowercase hex. Save it immediately to:

- 1Password (new entry; don't overwrite the old until rotation succeeds).
- Printed paper, sealed envelope, safe.

### 2. Stage the new KEK in Cloudflare

```bash
wrangler secret put TAPROOT_KEK_NEW
# paste the 64-char hex when prompted
```

`TAPROOT_KEK` (the live secret) is unchanged at this point. The Worker still has access to the old KEK as `TAPROOT_KEK`.

### 3. Re-wrap every DEK

Run the rotation script (lives at `scripts/rotate-kek.ts` — write this once, version-control, never delete):

```bash
TAPROOT_KEK=<old> TAPROOT_KEK_NEW=<new> npx tsx scripts/rotate-kek.ts
```

For each row in `tenant_keys`, the script:

1. Reads `wrapped_dek`.
2. Unwraps with `TAPROOT_KEK` (old) → DEK plaintext.
3. Wraps DEK with `TAPROOT_KEK_NEW` → new wrapped value.
4. Updates the row:
   - `wrapped_dek` = new wrapped value
   - `previous_dek` = old wrapped value (kept for grace period)
   - `key_version` = current + 1
   - `rotated_at` = now()

If the script fails partway through, `previous_dek` is the recovery path. Re-running the script is idempotent if it tracks already-rotated rows by `key_version`.

### 4. Verify decrypt with the new KEK

Pick 3-5 random workspaces. For each:

```bash
TAPROOT_KEK=<new> npx tsx scripts/verify-decrypt.ts --workspace <uuid>
```

The script unwraps the DEK using the new KEK and decrypts the most recent vault file. If any verification fails, **stop** — investigate before swapping the live secret.

### 5. Swap the live KEK

```bash
wrangler secret put TAPROOT_KEK
# paste the same 64-char hex used in step 1
wrangler secret delete TAPROOT_KEK_NEW
```

The Worker now uses the new KEK on every request. Wrapped DEKs in the database are already updated, so decrypt continues to work.

### 6. Audit-log the rotation

```sql
insert into audit_log (operation, details)
values ('kek_rotated', jsonb_build_object('rotated_at', now(), 'reason', '<reason>'));
```

`reason` examples: `"annual"`, `"suspected leak"`, `"personnel change"`, `"hardware change"`.

### 7. Grace-period cleanup

Wait **24 hours** to confirm no decrypt failures surface in error logs. Then clear `previous_dek`:

```sql
update tenant_keys set previous_dek = null where previous_dek is not null;
```

After this, the old KEK is unrecoverable from the database. Destroy the old printed paper copy. Replace the old 1Password entry.

## What if rotation fails partway

`previous_dek` is the safety net. If the rotation script crashes, every row that was updated has both `wrapped_dek` (new) and `previous_dek` (old). Recovery options:

- **Re-run the script** — idempotent if it filters by `key_version`. Safe.
- **Roll back to old KEK** — write a recovery script that copies `previous_dek` → `wrapped_dek` for every row, decrement `key_version`, set `rotated_at` back. The old KEK in `TAPROOT_KEK` (still live) decrypts. Both old and new KEK are valid until you destroy backups.

## What this procedure does NOT cover

- **DEK rotation per workspace.** Only KEK rotation. Per-workspace DEK rotation is more involved (requires re-encrypting every vault file blob in Storage) and is a separate procedure for incidents where a single workspace's DEK is suspected leaked.
- **Algorithm migration.** If we need to move from AES-256-GCM to a different algorithm, that's a separate procedure that rotates DEKs _and_ re-encrypts ciphertext.
- **Compromised audit log.** If the `audit_log` table itself is suspected tampered with, KEK rotation doesn't address it. Separate forensics required.
