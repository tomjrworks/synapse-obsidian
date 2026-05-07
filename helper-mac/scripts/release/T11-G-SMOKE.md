# T11-G — Universal Binary (Apple Silicon + Intel) Smoke Test

Manual end-to-end acceptance checklist for shipping a single universal-binary
DMG that runs natively on both Apple Silicon (arm64) and Intel (x86_64) Macs.
Run in order. All assertions must pass before marking the universal release
SHIPPED on prod R2.

**Plan reference:** [[2026-05-06-workstream-g-plan]] · companion to T11.10.
**Coverage gap explicitly accepted (G-D4):** native Intel hardware validation
is skipped; Rosetta-on-Apple-Silicon is used as a partial proxy. Document
the gap in the sign-off footer.

---

## Step 0 — Verify PRODUCT server is on current main commit

Locked 2026-05-08 after the F V1 incident: helper Sparkle releases ship
ahead of the server they depend on, because Railway does NOT auto-deploy
on git push (per `reference_taproot_deploy.md`). If the helper expects
F V1 endpoints (rules-preview, garden_index, garden_rules, etc.) and
PRODUCT is running pre-F V1 code, the fresh-user walk breaks silently.

```bash
# 1. Local main HEAD
cd ~/Documents/obsidian-brain
LOCAL=$(git rev-parse origin/main)
echo "Local origin/main: $LOCAL"

# 2. Currently-deployed Railway commit (via service health + agent OR
#    inspect Railway dashboard). If health returns a different version
#    string than expected for the current commit, OR if a route added
#    in the last 24h returns 404 to an unauthenticated probe (rather
#    than 401 "auth required"), PRODUCT is stale.
curl -sI https://connect.taproothq.com/api/onboarding/rules-preview \
  | grep "HTTP/"
# Expected: HTTP/2 401  (route exists, auth required)
# Bad:      HTTP/2 404  (route missing — PRODUCT is stale)
```

**If PRODUCT is stale, deploy first:**

```bash
cd ~/Documents/obsidian-brain
railway up --service determined-clarity --detach
# Build takes ~3-5 min. Re-run the curl probe to confirm the new endpoint
# returns 401 (or 200 if it's a no-auth route).
```

Only proceed to Step 1 once PRODUCT and helper-mac repos are in sync.

---

## Step 1 — Prep checks

```bash
# Cert in Keychain
security find-identity -v -p codesigning | grep "Developer ID Application"
# Expected: BC24E4A647583D1B567D8A0CD3DFBE74C3A2C522 (5ALAY5V34U)

# Notary profile works
xcrun notarytool history --keychain-profile taproot-notary
# Expected: list of prior submissions — no auth error

# create-dmg installed
create-dmg --version
# Expected: version string

# Sparkle EdDSA key + R2 wrangler auth current (G6 hotfix readiness)
# Sparkle key lives in macOS Keychain (`https://sparkle-project.org` / `ed25519`),
# read by `sign_update` automatically — no .pem file required for signing.
# A `.pem` backup is OPTIONAL (recovery convenience only).
security find-generic-password -s "https://sparkle-project.org" -a "ed25519" >/dev/null 2>&1 \
    && echo "Sparkle EdDSA key in Keychain ✓" \
    || echo "Sparkle EdDSA key MISSING in Keychain — sign_update will fail"
wrangler whoami 2>&1                     # authenticated to Cloudflare account
```

---

## Step 2 — Bump version

```bash
cd ~/Documents/obsidian-brain
git checkout -b t11-G-smoke-0.1.4
```

Edit `helper-mac/Sources/TaprootHelper/Info.plist` — bump both keys:

```
CFBundleShortVersionString  0.1.3 → 0.1.4
CFBundleVersion             4 → 5
```

---

## Step 3 — Build universal binary

```bash
mkdir -p /tmp/staging-0.1.4
bash helper-mac/scripts/release/build-app.sh /tmp/staging-0.1.4 --zip
```

**Assert — universal binary verified:**

```bash
lipo -info /tmp/staging-0.1.4/TaprootHelper.app/Contents/MacOS/TaprootHelper
# Expected: Architectures in the fat file: ... are: x86_64 arm64

# Sparkle framework should also be universal (already universal upstream).
lipo -info /tmp/staging-0.1.4/TaprootHelper.app/Contents/Frameworks/Sparkle.framework/Sparkle
# Expected: Architectures: x86_64 arm64

# Each slice has its own embedded Info.plist.
lipo /tmp/staging-0.1.4/TaprootHelper.app/Contents/MacOS/TaprootHelper -thin arm64 -output /tmp/h-arm64
lipo /tmp/staging-0.1.4/TaprootHelper.app/Contents/MacOS/TaprootHelper -thin x86_64 -output /tmp/h-x86_64
otool -X -s __TEXT __info_plist /tmp/h-arm64 | xxd -r -p | strings | grep CFBundleShortVersionString
otool -X -s __TEXT __info_plist /tmp/h-x86_64 | xxd -r -p | strings | grep CFBundleShortVersionString
# Both must report CFBundleShortVersionString.
rm /tmp/h-arm64 /tmp/h-x86_64
```

**Assert — timestamped signatures present (codesign signed both slices in one invocation):**

```bash
codesign -dvvv --verbose=2 /tmp/staging-0.1.4/TaprootHelper.app 2>&1 | grep -E "(Signed Time|Identifier|Authority)"
# Expected: "Signed Time=..." with a real ISO timestamp (NOT "absent")
```

---

## Step 4 — DMG creation + signing (T11.10 step 4 — unchanged)

```bash
bash helper-mac/scripts/release/package-dmg.sh /tmp/staging-0.1.4/TaprootHelper.app /tmp/staging-0.1.4
```

Note: `package-dmg.sh` requires two positional args: `<app-path> <output-dir>`.

Asserts the DMG was created and code-signed. Same flow as T11.10; no
arch-specific change. The DMG wraps a single `.app` whose `Contents/MacOS/*`
binary is universal — no per-arch DMG forking.

**Assert — DMG size sanity-check:**

```bash
ls -lh /tmp/staging-0.1.4/*.dmg
# Empirical: 0.1.4 universal DMG ~1.4 MB vs. 0.1.3 arm64-only at ~1.16 MB.
# The helper Mach-O is the only thing that doubles; Sparkle.framework was
# already universal, so the +250 KB delta is just the duplicated helper
# slice + UDZO compression overhead. If the DMG is >50 MB something is
# wrong (likely Sparkle dupe).
```

---

## Step 5 — Notarize

```bash
bash helper-mac/scripts/release/notarize.sh /tmp/staging-0.1.4/TaprootHelper-0.1.4.dmg
```

Identical to T11.10. Notarization treats universal binaries identically to
single-arch — Apple notarizes the Mach-O regardless of slice count.

**Assert — stapled:**

```bash
xcrun stapler validate /tmp/staging-0.1.4/TaprootHelper-0.1.4.dmg
# Expected: The validate action worked!
```

---

## Step 6 — Sparkle sign + appcast generate

```bash
bash helper-mac/scripts/release/sign-and-publish.sh 0.1.4 5 /tmp/staging-0.1.4/TaprootHelper-0.1.4.dmg --prod
```

Note: `sign-and-publish.sh` requires three positional args: `<short-version>
<bundle-version> <dmg-path>` plus optional `--prod` to use prod URLs in the
appcast `<enclosure>`. Script writes the appcast to
`helper-mac/scripts/release/out/appcast.xml`.

Same flow as T11.10. The appcast template's single `<enclosure>` works for
universal DMGs — no per-arch filtering needed (G-D1).

**Assert — appcast XML produced:**

```bash
grep -E "<title>|<sparkle:version>|enclosure|edSignature" \
    helper-mac/scripts/release/out/appcast.xml
# Expected: title "Version 0.1.4", sparkle:version 5, single enclosure
# pointing at TaprootHelper-0.1.4.dmg with sparkle:edSignature populated.
```

---

## Step 7 — Rosetta proxy smoke (Apple Silicon host) — NEW vs. T11.10

Native Intel hardware is unavailable per G-D4. Rosetta is a partial proxy
that catches the most likely Intel-slice failure modes; what it covers and
what it doesn't is documented below — both go into the sign-off footer.

```bash
# Mount the DMG so we run from the actual installable artifact.
hdiutil attach /tmp/staging-0.1.4/TaprootHelper-0.1.4.dmg
# package-dmg.sh sets the volume name from the app's CFBundleDisplayName,
# which renders as "Taproot Helper <version>" (with spaces, no hyphen).
APP="/Volumes/Taproot Helper 0.1.4/TaprootHelper.app"

# Verify Mach-O slice composition straight from the mounted DMG.
file "$APP/Contents/MacOS/TaprootHelper"
# Expected: "Mach-O universal binary with 2 architectures: [arm64:...] [x86_64:...]"

# Force-launch the x86_64 slice via Rosetta.
arch -x86_64 "$APP/Contents/MacOS/TaprootHelper" &
HELPER_PID=$!
sleep 3

# Verify the helper is alive. macOS does NOT expose per-PID
# proc_translated via sysctl (only the calling process's status).
# The reliable Rosetta marker is Activity Monitor's "Kind" column —
# the launched PID should show Kind="Intel" (vs Apple for native arm64).
ps -p "$HELPER_PID" -o pid,command
# Manual: open Activity Monitor → search "TaprootHelper" → Kind="Intel"
# for the PID printed above.

# URL-scheme handler must respond.
open "taproot://noop?source=t11-g-rosetta-smoke"
# Expected: helper logs an "ignoring unknown URL action" line and stays alive.

# Settings → Version reads correctly from the x86_64 slice's Info.plist.
# (Manual: open menubar → Settings → Version row should read "0.1.4 (5)")

# Cleanup.
kill "$HELPER_PID" 2>/dev/null
hdiutil detach "/Volumes/Taproot Helper 0.1.4"
```

**Coverage this proxy GIVES you:**

- x86_64 slice is well-formed Mach-O (slice missing → `arch -x86_64` errors at exec).
- Codesigning landed correctly on the x86_64 slice (Gatekeeper would block).
- Framework linking resolves on x86_64 (dyld would fail at launch).
- `__info_plist` section embedded in the x86_64 slice (Bundle.main version read).
- AppKit/Cocoa init path runs on x86_64 (menubar item appears).
- URL-scheme handler registers and dispatches on x86_64.

**Coverage this proxy does NOT give you:**

- Intel-native syscall paths — Rosetta retranslates x86_64 syscalls.
- Intel-CPU-specific codegen bugs (rare for our pure-Swift workload).
- Hardware differences in IOKit / display / power on real Intel Macs.

These are the residual risk class accepted in G-D4. Mitigation is post-ship
monitoring (G6) + 2-hour hotfix readiness, not pre-ship validation.

---

## Step 8 — Apple Silicon native regression smoke

Re-walk the relevant T11.9 + T11.8 happy-path steps on the M-series host
running native arm64. The universal binary must not regress arm64.

Minimum:

- Install from DMG → menubar icon appears.
- Sign in via OAuth (T11.9 step 4 / T11.8 step 5 equivalent).
- Confirm first-run vault picker (Workstream B) renders correctly.
- Receive a Sparkle update notification (point appcast at this build's
  signature, observe Sparkle dialog appearing in-app).
- Sync 1 file from the connected Obsidian vault → server confirms write.

Any regression here is a P0 — universal binary must not break the existing
arm64 ship path.

---

## Step 9 — Promote to prod R2 + appcast

Identical to T11.10:

```bash
# Per the wrangler commands sign-and-publish.sh prints in step 6.
wrangler r2 object put taproot-downloads/releases/v0.1.4/TaprootHelper-0.1.4.dmg --file=...
wrangler pages deploy ... # appcast
```

**Assert — prod URLs serve the universal DMG:**

```bash
curl -sI https://downloads.taproothq.com/releases/v0.1.4/TaprootHelper-0.1.4.dmg | head -1
# Expected: HTTP/2 200

curl -s https://updates.taproothq.com/appcast.xml | grep enclosure
# Expected: enclosure pointing at v0.1.4 DMG.

# Sanity: download once and verify lipo on the wire bytes.
curl -L https://downloads.taproothq.com/releases/v0.1.4/TaprootHelper-0.1.4.dmg -o /tmp/wire.dmg
hdiutil attach /tmp/wire.dmg -nobrowse -quiet -mountpoint /tmp/wire-mnt
lipo -info /tmp/wire-mnt/TaprootHelper.app/Contents/MacOS/TaprootHelper
# Expected: Architectures: x86_64 arm64
hdiutil detach /tmp/wire-mnt -quiet
rm /tmp/wire.dmg
```

---

## Step 10 — SITE coordination (G7)

Re-enable the Intel button on `taproothq.com` onboarding:

1. Locate the disabled button in `~/Documents/agency/taproothq/` (commit
   `7810225` disabled it).
2. Re-enable; verify the download URL points at the same
   `downloads.taproothq.com/releases/v0.1.4/TaprootHelper-0.1.4.dmg`
   pattern as the Apple Silicon button (single artifact per G-D1).
3. Deploy SITE to prod.

**Assert — both buttons on onboarding download the same bytes:**

```bash
# The two button download URLs should be identical (single universal
# artifact). Confirm by visiting both, checking the request URL, and
# verifying byte-equality with sha256 if curious.
```

No further smoke gate per G-D5 — Intel users come online; G6 monitoring picks
up any issues that surface.

---

## Step 11 — Rollback procedure (document, do not execute)

If a clearly broken Intel build hits prod, fastest mitigation is to revert
the appcast `<enclosure>` URL to the prior known-good arm64-only DMG (0.1.3)
and disable the Intel button on SITE again:

```bash
# Edit appcast.xml back to the 0.1.3 enclosure URL.
wrangler pages deploy ... # appcast revert
# Edit SITE to re-disable Intel button; redeploy.
```

Total rollback time target: ≤10 min. Document the rollback test in the
sign-off footer so anyone reading the audit trail knows it's been planned.

---

## Sign-off footer

```
Walked: <date>
Operator: <name>
Build: <commit hash>
Universal binary verified: yes / no
Rosetta proxy smoke: PASS / FAIL (notes: ...)
Apple Silicon regression smoke: PASS / FAIL (notes: ...)
Native Intel hardware validation: SKIPPED per G-D4
Rollback procedure: documented / tested
G6 monitoring posture: CREDS-OK / NEEDS-SETUP
```

---

## Walk log

### 0.1.4 — 2026-05-07 (cfd510d) — SHIPPED

```
Walked:                              2026-05-07
Operator:                            Tom + Claude (Sonnet, autonomous drive)
Build:                               cfd510d (obsidian-brain) + 16635c6 (agency)
Notarization submission ID:          dc92bd3e-0837-4c88-bd9e-7dc1922211a5 (Accepted)
Universal binary verified:           YES — lipo: x86_64 + arm64 (helper Mach-O + Sparkle.framework)
Rosetta proxy smoke:                 PASS — Activity Monitor Kind=Intel for forced-arch launch (PID 12491);
                                     keychain bearer loaded, watcher fired on real vault under x86_64 slice.
Apple Silicon regression smoke:      PASS — drag-install clean (no Gatekeeper); Settings reads 0.1.4;
                                     Sparkle "Check for updates" reads prod feed correctly ("you're up to date,
                                     newest is 0.1.3, you're on 0.1.4"); "Open in Obsidian" menu item lands
                                     correct URL (`obsidian://open?path=...`) — Obsidian receives + parses
                                     cleanly, errored only because corrupted-account vault path isn't a real
                                     Obsidian vault (expected, not 0.1.4 regression).
Native Intel hardware validation:    SKIPPED per G-D4
Rollback procedure:                  documented (Step 11), not tested
G6 monitoring posture:               CREDS-OK — Sparkle EdDSA in Keychain, wrangler authed (tomjrworks@gmail.com)
Prod URLs verified:                  https://downloads.taproothq.com/releases/v0.1.4/TaprootHelper-0.1.4.dmg
                                     (HTTP/2 200, sha256 byte-equal local↔remote)
                                     https://updates.taproothq.com/appcast.xml
                                     (sparkle:version=5, valid edSignature)
```
