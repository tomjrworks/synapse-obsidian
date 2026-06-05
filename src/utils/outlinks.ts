// ─────────────────────────────────────────────────────────────────────────
// Pass 4b — garden_backlinks v2: write-time [[wikilink]] outlink extraction.
//
// The whole precision story rides on this: only a literal [[…]] edge counts —
// a prose mention that merely tokenizes the same is NOT a backlink. We resolve
// each link body to a canonical basename KEY the same way the rest of the
// system does (mirrors the knowledge.ts health scan + PR #15's derive-on-read
// resolver), extract the deduped set a body links OUT to at WRITE time, and
// store it in the `extracted_outlinks` JSONB column (migration 0031), mirroring
// exactly how Pass 3 stores `extracted_tokens`. garden_backlinks then reads the
// column — no per-call full-vault body scan (the bac2d1b 4–13 min prod-hang
// class on the encrypted mirror), scales like the token index.
//
// CONTENT-derived only and PURE: safe on any string, never throws.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve a link body or a target arg to its canonical basename KEY: drop a
 * `|alias` and a `#heading`, take the basename, strip a trailing .md, lowercase,
 * spaces→hyphens. The target side and the stored-outlink side both run through
 * this, so resolution is symmetric: `[[module-1|Module 1]]`,
 * `[[module-1#Frameworks]]`, `school/.../module-1.md`, and `module-1` all
 * collapse to the same key.
 */
export function linkKey(raw: string): string {
  const base = raw.split("|")[0].split("#")[0].trim().replace(/\.md$/i, "");
  const name = base.slice(base.lastIndexOf("/") + 1);
  return name.toLowerCase().replace(/\s+/g, "-");
}

const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;

/** The set of [[wikilink]] target keys a body links OUT to (deduped). */
export function outlinkKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const k = linkKey(m[1]);
    if (k) keys.add(k);
  }
  return keys;
}

/** Per-file stored outlink record: the sorted, deduped set of resolved
 * [[wikilink]] target keys this file links OUT to. Sorted for deterministic
 * column payloads (stable diffs, stable test fixtures). */
export type FileOutlinks = string[];

/**
 * Extract the per-file outlink record for the `extracted_outlinks` column
 * (write hook + backfill). Scans the WHOLE content — a [[wikilink]] is a real
 * edge wherever it appears (frontmatter or body). Pure; never throws.
 */
export function extractOutlinks(_content: string): FileOutlinks {
  // STUB (RED baseline) — implemented in the next commit.
  return [];
}
