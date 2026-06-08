// ─────────────────────────────────────────────────────────────────────────
// Pass 5 — wikilink dangling-set (decision 2026-06-06-pass-5-direction, fork 2).
//
// The DIFF the deep-read found "computed nowhere": dangling = (every resolved
// [[wikilink]] target a file links OUT to) − (the set of pages that actually
// exist). Built on the SAME canonical resolver as the write path / garden_backlinks
// (`outlinkKeys` / `linkKey` in outlinks.ts) — NOT taproot_prune's ad-hoc basename
// regex (knowledge.ts:1171), which false-flags code-fenced links and `#heading`
// targets. Server SURFACES dangling targets; creation stays the AI's job via
// garden_plant (no server-generated content — fork 2 "keep creation manual").
//
// Pure; never throws.
// ─────────────────────────────────────────────────────────────────────────

/** A wikilink target key that no existing page satisfies, plus the source files
 * (vault-relative paths) that point at it. Sorted shape for deterministic
 * payloads / stable test fixtures. */
export type DanglingTarget = { key: string; sources: string[] };

/**
 * Compute the dangling-target set.
 *
 * @param existing  canonical page keys that DO exist (each page basename run
 *                  through `linkKey`). Membership here = "the link resolves".
 * @param outlinksByFile  vault-path → that file's stored `extracted_outlinks`
 *                  (already canonical keys, code-spans already excluded by
 *                  `extractOutlinks`). Mirror of the persisted column.
 * @returns         one entry per distinct dangling key, sorted by key, each with
 *                  its sorted source paths deduped.
 */
export function danglingTargets(
  existing: Set<string>,
  outlinksByFile: Record<string, string[]>,
): DanglingTarget[] {
  // target key → set of source paths that link to it but find no existing page.
  const bySources = new Map<string, Set<string>>();
  for (const [sourcePath, keys] of Object.entries(outlinksByFile)) {
    for (const key of keys) {
      if (existing.has(key)) continue; // resolves → not dangling
      let sources = bySources.get(key);
      if (!sources) {
        sources = new Set<string>();
        bySources.set(key, sources);
      }
      sources.add(sourcePath);
    }
  }
  return [...bySources.entries()]
    .map(([key, sources]) => ({ key, sources: [...sources].sort() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
