import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import { respondToolError } from "./_rate-limit.js";
import { withTelemetry } from "../observability/tool-telemetry.js";
import {
  getRetrievalIndex,
  scoreQuery,
  resolveBackfillConcurrency,
  type RetrievalIndex,
} from "../utils/retrieval-index.js";
import { tokenize, isIdentifierToken } from "../utils/tokenize.js";
import { runsOf } from "../utils/honesty-contract.js";
import { readVaultFile, parseFrontmatter } from "../utils/vault.js";
import {
  linkKey,
  extractOutlinks,
  type FileOutlinks,
} from "../utils/outlinks.js";

/**
 * Pass 4a — three READ-ONLY retrieval primitives layered on the EXISTING Pass 3
 * index (getRetrievalIndex → RetrievalIndex) + scoreQuery. No write-path change,
 * no new index structure, no Supabase migration (code-only deploy).
 *
 *   - garden_identifier  exact-id recall + run-collision precision + related-id
 *   - garden_query       structured/boolean query (AND-default, field scopes)
 *   - garden_cluster     topic clusters + suggest-then-create landing note
 *
 * Each behind its own per-tool flag (TAPROOT_GARDEN_*). Register-always,
 * gate-behavior (honesty/V2 precedent): the tool is always registered so the
 * telemetry wrapper sees attempted calls; a flag-OFF call returns a short inert
 * "disabled" response with NO index read. Flags are independent.
 *
 * The TAPROOT-MANAGED root index.md is excluded from every result — it is a
 * generated catalog that lexically contains nearly every term/identifier, so a
 * set-membership primitive must never surface it (precision).
 *
 * PLAN: 2026-06-04-pass-4a-plan. SPEC: 2026-06-04-pass-4a-spec. Gates:
 * 2026-06-04-pass-4-primitives-evals (§2–4 + cross-cutting), all GREEN.
 */

// ── Per-tool behavior flags (honesty-contract.ts:33 one-liner pattern) ──
function gardenIdentifierEnabled(): boolean {
  return process.env.TAPROOT_GARDEN_IDENTIFIER === "1";
}
function gardenQueryEnabled(): boolean {
  return process.env.TAPROOT_GARDEN_QUERY === "1";
}
function gardenClusterEnabled(): boolean {
  return process.env.TAPROOT_GARDEN_CLUSTER === "1";
}
function gardenBacklinksEnabled(): boolean {
  return process.env.TAPROOT_GARDEN_BACKLINKS === "1";
}

/** Inert flag-OFF response: no index read, short text, telemetry flag set. */
function disabledResponse(tool: string): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [
      {
        type: "text" as const,
        text: `${tool} is not enabled for this workspace.`,
      },
    ],
  };
}

// ── Shared retrieval helpers (PLAN §2.0 / §2a) ─────────────────────────────
type Rec = RetrievalIndex["files"][number];

/** The TAPROOT-MANAGED root index is a generated catalog — it lexically
 * contains nearly every identifier/term in the vault, so a set-membership
 * primitive must never surface it as a hit (it would break precision). */
const MANAGED_INDEX_PATH = "index.md";
function isExcludedFromResults(p: string): boolean {
  return p === MANAGED_INDEX_PATH;
}

const RESULT_LIMIT = 20;

/** Every token of a record across all fields (mirrors honesty-contract.ts:92). */
function fileTokenSet(rec: Rec): Set<string> {
  return new Set<string>([
    ...rec.filename,
    ...rec.frontmatter,
    ...rec.folder,
    ...rec.body,
  ]);
}

/**
 * Identifier match targets (the SUBTLE sub-token rule — do not "simplify"):
 * tokenize the raw identifier, keep only id-shaped tokens, and for each emit
 * the token itself PLUS its digit/letter sub-runs, dropping any run of length
 * < 2 and any pure-letter (non-id) run. Threads two needles at once:
 *   is7011 → {is7011, 7011}  (course notes carry only the `7011` sub-token)
 *   pr7    → {pr7}           (`7` dropped len<2, `pr` dropped non-id → never pr8/pr9)
 *   7011   → {7011};  is → {} (no id target → IDN5 hint)
 */
function deriveIdentifierTargets(identifier: string): string[] {
  const targets = new Set<string>();
  for (const tok of tokenize(identifier)) {
    if (!isIdentifierToken(tok)) continue;
    for (const part of [tok, ...runsOf(tok)]) {
      if (part.length < 2) continue;
      if (!isIdentifierToken(part)) continue;
      targets.add(part);
    }
  }
  return [...targets];
}

/** Identifier-shaped vocabulary (token → cross-field document frequency). */
function identifierVocab(index: RetrievalIndex): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const rec of index.files) {
    for (const t of fileTokenSet(rec)) {
      if (isIdentifierToken(t)) vocab.set(t, (vocab.get(t) ?? 0) + 1);
    }
  }
  return vocab;
}

/**
 * Related identifiers for an exact miss: vault identifier tokens sharing a
 * digit/letter run with an unmatched id-shaped query token, ranked by vocab
 * frequency, capped. Duplicates honesty-contract.ts:148-165 (audit decision:
 * share runsOf only, not the whole matcher).
 */
function relatedIdentifiers(
  unmatchedIds: string[],
  vocab: Map<string, number>,
  cap = 3,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const vocabIds = [...vocab.keys()];
  for (const qt of unmatchedIds) {
    const qRuns = new Set(runsOf(qt));
    const cands = vocabIds
      .filter(
        (c) => c !== qt && !seen.has(c) && runsOf(c).some((r) => qRuns.has(r)),
      )
      .sort((a, b) => (vocab.get(b) ?? 0) - (vocab.get(a) ?? 0));
    for (const c of cands.slice(0, cap)) {
      out.push(c);
      seen.add(c);
    }
  }
  return out.slice(0, cap);
}

/** Render matched paths as `- **<title>** — <path>` (mirrors garden_find so a
 * shared parse branch works). Reads frontmatter title for the rendered slice
 * only (already limited), basename fallback. */
async function renderHits(
  backend: StorageBackend,
  paths: string[],
): Promise<string> {
  const lines: string[] = [];
  for (const p of paths) {
    let title = path.basename(p, ".md");
    try {
      const fm = parseFrontmatter(await readVaultFile(backend, p));
      if (typeof fm.title === "string" && fm.title.trim()) title = fm.title;
    } catch {
      /* title is best-effort — basename fallback */
    }
    lines.push(`- **${title}** — ${p}`);
  }
  return lines.join("\n");
}

// ── garden_backlinks: stored-outlink backfill (the migration-day cold tail) ──
// In-flight guard so a flush-warm and a concurrent backlinks call don't both
// decrypt the same rows. Mirrors retrieval-index.ts backfillNullTokens exactly:
// this is the ONE expensive path (reads encrypted blobs), so it is one-time per
// file (column null exactly once, ever), fire-and-forget (never blocks a query),
// chunked, and in-flight-guarded. The .is(null) write-side race-guard makes the
// WRITES idempotent; this just avoids wasted duplicate reads.
const outlinkBackfillInFlight = new WeakSet<StorageBackend>();

// M2 — bound the per-call cold-tail backfill. Uncapped, the first backlinks
// call on an all-null column decrypts EVERY file (per replica) — a background
// CPU/DB spike. Cap ON by default (unset => 1000, the historical token-backfill
// cap); the column still drains over a few calls, and deploy-warm populates it
// up front anyway. OUTLINK_BACKFILL_CAP=0 is the explicit unbounded escape hatch
// (mirrors resolveScanCap's SCAN_FILE_CAP=0). Clamped >= 1.
function resolveOutlinkBackfillCap(): number | undefined {
  const raw = process.env.OUTLINK_BACKFILL_CAP;
  if (raw === undefined) return 1000;
  const trimmed = raw.trim();
  if (trimmed === "0") return undefined; // unbounded legacy
  if (trimmed === "") return 1000;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

async function backfillNullOutlinks(
  backend: StorageBackend,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  if (!backend.batchUpdateOutlinks) return;
  if (outlinkBackfillInFlight.has(backend)) return;
  outlinkBackfillInFlight.add(backend);
  try {
    // Chokepoint cap so EVERY caller is bounded, not just the dispatch site.
    const cap = resolveOutlinkBackfillCap();
    const work = cap === undefined ? paths : paths.slice(0, cap);
    const concurrency = resolveBackfillConcurrency();
    const updates = new Map<string, FileOutlinks>();
    for (let i = 0; i < work.length; i += concurrency) {
      const chunk = work.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (p) => {
          try {
            updates.set(p, extractOutlinks(await readVaultFile(backend, p)));
          } catch {
            // Unreadable (e.g. deleted mid-flight) — skip; never abort the run.
          }
        }),
      );
    }
    if (updates.size > 0) await backend.batchUpdateOutlinks(updates);
  } finally {
    outlinkBackfillInFlight.delete(backend);
  }
}

// ── garden_query: minimal boolean grammar (PLAN §2b) ───────────────────────
// Supports `A B` (AND), `A OR B …` (one OR group), `X NOT Y`, and field scopes
// tag:/type:/folder:/path: — exactly enough for GQ1–GQ5. No nested parens /
// quoted phrases (graceful: unknown key:val → a bare term, never throws).
type QueryTerm =
  | { kind: "tag" | "type" | "folder"; value: string }
  | { kind: "path"; value: string }
  | { kind: "bare"; value: string };

function classifyTerm(word: string): QueryTerm {
  const m = /^(tag|type|folder|path):(.+)$/i.exec(word);
  if (m) {
    const field = m[1].toLowerCase();
    const raw = m[2];
    if (field === "path") return { kind: "path", value: raw.toLowerCase() };
    // tag/type/folder → content-tokenize the value, take the first token (the
    // scope values in 4a are single-token; exact set membership downstream).
    const value = tokenize(raw)[0] ?? raw.toLowerCase();
    return { kind: field as "tag" | "type" | "folder", value };
  }
  return { kind: "bare", value: tokenize(word)[0] ?? word.toLowerCase() };
}

interface ParsedQuery {
  and: QueryTerm[];
  orGroups: QueryTerm[][];
  not: QueryTerm[];
  scopeCount: number;
  operatorCount: number;
}

function parseQuery(query: string): ParsedQuery {
  const words = query.split(/\s+/).filter(Boolean);
  const and: QueryTerm[] = [];
  const orGroups: QueryTerm[][] = [];
  const not: QueryTerm[] = [];
  let orGroup: QueryTerm[] = [];
  let pendingNot = false;
  let expectOrOperand = false;
  let operatorCount = 0;
  const flushOr = () => {
    if (orGroup.length) {
      orGroups.push(orGroup);
      orGroup = [];
    }
  };
  for (const w of words) {
    const U = w.toUpperCase();
    if (U === "NOT") {
      operatorCount += 1;
      pendingNot = true;
      continue;
    }
    if (U === "OR") {
      operatorCount += 1;
      // The term just before this OR joins the group (pull it back out of AND).
      if (orGroup.length === 0 && and.length) orGroup.push(and.pop()!);
      expectOrOperand = true;
      continue;
    }
    const term = classifyTerm(w);
    if (pendingNot) {
      not.push(term);
      pendingNot = false;
    } else if (expectOrOperand) {
      orGroup.push(term);
      expectOrOperand = false;
    } else {
      flushOr();
      and.push(term);
    }
  }
  flushOr();
  const scopeCount = [...and, ...orGroups.flat(), ...not].filter(
    (t) => t.kind !== "bare",
  ).length;
  return { and, orGroups, not, scopeCount, operatorCount };
}

/** Is a term satisfied by a record? Scopes use their exact field; a bare term
 * matches NON-body (filename ∪ frontmatter ∪ folder) under AND, but the FULL
 * token set (incl. body) under OR / NOT — the audit-resolved asymmetry that
 * lets GQ4 exclude the body-only `mcp` standup while GQ5 keeps body-resident
 * OR terms. */
function termPresent(rec: Rec, term: QueryTerm, allowBody: boolean): boolean {
  switch (term.kind) {
    case "tag":
    case "type":
      return rec.frontmatter.has(term.value);
    case "folder":
      return rec.folder.has(term.value);
    case "path":
      return rec.path.toLowerCase().includes(term.value);
    case "bare":
      return allowBody
        ? fileTokenSet(rec).has(term.value)
        : rec.filename.has(term.value) ||
            rec.frontmatter.has(term.value) ||
            rec.folder.has(term.value);
  }
}

function queryMatches(rec: Rec, p: ParsedQuery): boolean {
  return (
    p.and.every((t) => termPresent(rec, t, false)) &&
    p.orGroups.every((g) => g.some((t) => termPresent(rec, t, true))) &&
    !p.not.some((t) => termPresent(rec, t, true))
  );
}

// ── garden_cluster: topic clustering + landing-note proposal (PLAN §2c) ────
// Structure locked, numbers tuned against the fixture (audit §6.3). Two files
// are "related" if they (a) share an identifier RUN of len≥2 — the family
// signal that binds pr7/pr8/pr9 and the is-7011 modules even though their
// bodies are dissimilar — OR (b) clear a content-Jaccard floor on high-signal
// tokens. Identifier runs are taken from frontmatter+body ONLY (NOT filename),
// so filename DATE tokens (2026/05) never manufacture a false family across
// every dated daily.
const CLUSTER_JACCARD_MIN = 0.25;
const CLUSTER_MAX = 12;
const CLUSTER_MEMBER_MAX = 25;
const CLUSTER_SCAN_CAP = 500; // O(n²) pairing guard for large vaults (4a)
const GENERIC_TOP_FOLDERS = new Set(["daily", "notes", "inbox", "meetings"]);

interface ClusterNode {
  rec: Rec;
  sig: Set<string>; // high-signal content tokens
  runs: Set<string>; // identifier runs (len≥2) from frontmatter+body
}

function clusterDf(files: Rec[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const rec of files) {
    for (const t of fileTokenSet(rec)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

function contentSig(
  rec: Rec,
  df: Map<string, number>,
  maxDf: number,
): Set<string> {
  const s = new Set<string>();
  for (const t of fileTokenSet(rec)) {
    if (!(isIdentifierToken(t) || t.length > 2)) continue; // drop len≤2 non-id
    if ((df.get(t) ?? 0) > maxDf) continue; // drop ubiquitous (handoff, the…)
    s.add(t);
  }
  return s;
}

function clusterIdRuns(rec: Rec): Set<string> {
  const runs = new Set<string>();
  for (const t of [...rec.frontmatter, ...rec.body]) {
    if (!isIdentifierToken(t)) continue;
    for (const r of runsOf(t)) if (r.length >= 2) runs.add(r);
  }
  return runs;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function clusterRelated(a: ClusterNode, b: ClusterNode): boolean {
  for (const r of a.runs) if (b.runs.has(r)) return true; // identifier family
  return jaccard(a.sig, b.sig) >= CLUSTER_JACCARD_MIN; // content similarity
}

function isGenericFolder(folder: string): boolean {
  if (folder === ".") return true;
  if (GENERIC_TOP_FOLDERS.has(folder.split("/")[0])) return true;
  return /^\d/.test(path.basename(folder)); // bare date folder
}

const titleCase = (toks: string[]): string =>
  toks.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");

/** Landing-note title + proposed path for a cluster. Prefers a specific
 * dominant folder's name (e.g. is-7011-it-management); falls back to the
 * cluster's shared distinctive tokens, then to a generic label. */
function clusterTitleAndPath(
  recs: Rec[],
  df: Map<string, number>,
): { title: string; landingPath: string } {
  const folderCounts = new Map<string, number>();
  for (const r of recs) {
    const f = path.dirname(r.path);
    folderCounts.set(f, (folderCounts.get(f) ?? 0) + 1);
  }
  const dominant = [...folderCounts.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      Number(isGenericFolder(a[0])) - Number(isGenericFolder(b[0])) ||
      a[0].localeCompare(b[0]),
  )[0][0];

  let titleToks: string[] = [];
  if (!isGenericFolder(dominant)) {
    titleToks = tokenize(path.basename(dominant)).filter((t) => t.length >= 2);
  }
  if (titleToks.length === 0) {
    // Shared distinctive tokens across all members, rarest first.
    const sigs = recs.map((r) => contentSig(r, df, recs.length));
    const shared = [...sigs[0]].filter(
      (t) => t.length >= 2 && sigs.every((s) => s.has(t)),
    );
    titleToks = shared
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0))
      .slice(0, 4);
  }
  const title = titleToks.length ? titleCase(titleToks) : "Related notes";
  const landingPath = dominant === "." ? "index.md" : `${dominant}/index.md`;
  return { title, landingPath };
}

function renderCluster(
  titleRecs: Rec[],
  memberPaths: string[],
  df: Map<string, number>,
): string {
  const { title, landingPath } = clusterTitleAndPath(titleRecs, df);
  const lines = [
    `## ${title}`,
    `Suggested landing note: \`${landingPath}\` — "${title}" (proposal — call garden_plant to create; nothing is written).`,
    `Members (${memberPaths.length}):`,
    ...memberPaths.map((p) => `- ${p}`),
  ];
  return lines.join("\n");
}

export function registerGardenPrimitives(
  server: McpServer,
  backend: StorageBackend,
  opts: { workspaceId?: string; retrievalV2?: boolean } = {},
): void {
  // ── garden_identifier ──────────────────────────────────────────────────
  server.registerTool(
    "garden_identifier",
    {
      title: "Find notes by identifier",
      description:
        "Use this whenever the user references a note by a code or identifier — a course code, PR number, version, ticket. Returns notes whose tokens contain that exact identifier (digit-bearing), and on a miss suggests close identifiers in the vault. Triggers: 'my IS 7011 notes', 'the pr7 writeup', 'notes tagged v2', 'find s62'. For keyword/topic search prefer `garden_find`; for body-text search prefer `garden_forage`.",
      inputSchema: {
        identifier: z
          .string()
          .describe("The identifier to match (e.g. 'is7011', 'pr7', 'v2')."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        tool: "garden_identifier",
        kind: "read",
        effect: "read",
        workspaceId: opts.workspaceId,
        argsShape: ({ identifier }) => ({ identifier_len: identifier.length }),
      },
      async ({ identifier }, ctx) => {
        try {
          if (!gardenIdentifierEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_identifier");
          }

          const targets = deriveIdentifierTargets(identifier);
          ctx.flags.identifier_targets = targets.length;

          // IDN5 — no id-shaped target (e.g. "is"): empty-with-hint, not error.
          if (targets.length === 0) {
            ctx.noResults = true;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${identifier}" isn't an identifier — identifiers contain a digit (e.g. is7011, pr7, v2). Try garden_find for keyword search.`,
                },
              ],
            };
          }

          const index = await getRetrievalIndex(backend);
          const targetSet = new Set(targets);

          // Match: any target token ∈ the file's token set; the managed root
          // index is a generated catalog → never a hit (precision).
          const matched = new Set(
            index.files
              .filter(
                (rec) =>
                  !isExcludedFromResults(rec.path) &&
                  [...fileTokenSet(rec)].some((t) => targetSet.has(t)),
              )
              .map((rec) => rec.path),
          );

          // Order survivors by relevance (scoreQuery), then append any matched
          // path the scorer didn't rank (defensive — matched ⊆ scored here).
          const ordered: string[] = [];
          const seen = new Set<string>();
          for (const hit of scoreQuery(index, identifier)) {
            if (matched.has(hit.path) && !seen.has(hit.path)) {
              ordered.push(hit.path);
              seen.add(hit.path);
            }
          }
          for (const p of [...matched].sort()) {
            if (!seen.has(p)) ordered.push(p);
          }
          const top = ordered.slice(0, RESULT_LIMIT);

          ctx.flags.exact_hits = top.length;
          ctx.resultCount = top.length;

          // IDN4 — id target(s) but zero exact hits: related-id suggestions
          // (never as exact hits), reusing the run-overlap matcher.
          if (top.length === 0) {
            ctx.noResults = true;
            const queryIds = tokenize(identifier).filter(isIdentifierToken);
            const related = relatedIdentifiers(
              queryIds,
              identifierVocab(index),
            );
            ctx.flags.related_suggested = related.length;
            const tail = related.length
              ? ` Related identifiers in your vault: ${related.join(", ")}.`
              : " No related identifiers found.";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No exact match for "${identifier}".${tail}`,
                },
              ],
            };
          }

          return {
            content: [
              { type: "text" as const, text: await renderHits(backend, top) },
            ],
          };
        } catch (err) {
          ctx.errorCode = "garden_identifier_failed";
          return respondToolError("garden_identifier_failed", err);
        }
      },
    ),
  );

  // ── garden_query ─────────────────────────────────────────────────────────
  server.registerTool(
    "garden_query",
    {
      title: "Structured query over your vault",
      description:
        "Use this for a PRECISE, structured search: multiple terms that must ALL be present (AND by default), field scopes (tag:, type:, folder:, path:), and OR / NOT operators. Triggers: 'notes tagged ai in school', 'type:decision about pricing', 'pr7 OR pr8', 'mcp but not audit'. For a broad single-topic search prefer `garden_find`; for body-text grep prefer `garden_forage`.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Structured query: bare terms (AND), tag:/type:/folder:/path: scopes, OR / NOT.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        tool: "garden_query",
        kind: "read",
        effect: "read",
        workspaceId: opts.workspaceId,
        argsShape: ({ query }) => ({ query_len: query.length }),
      },
      async ({ query }, ctx) => {
        try {
          if (!gardenQueryEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_query");
          }

          const parsed = parseQuery(query);
          ctx.flags.query_scopes = parsed.scopeCount;
          ctx.flags.query_operators = parsed.operatorCount;

          const noResult = (text: string) => {
            ctx.noResults = true;
            ctx.resultCount = 0;
            return { content: [{ type: "text" as const, text }] };
          };

          // No positive constraint (empty, or NOT-only) → nothing to return.
          if (parsed.and.length === 0 && parsed.orGroups.length === 0) {
            return noResult(`No files match \`${query}\`.`);
          }

          const index = await getRetrievalIndex(backend);

          // Inclusion IS the predicate (not scoreQuery coverage — GOTCHA #3):
          // every predicate-passing file is included; scoreQuery only ORDERS
          // within the survivor set. The managed catalog is never a hit.
          const survivors = index.files.filter(
            (rec) =>
              !isExcludedFromResults(rec.path) && queryMatches(rec, parsed),
          );

          if (survivors.length === 0) {
            return noResult(`No files match \`${query}\`.`);
          }

          // Rank survivors by relevance over the positive content terms.
          const rankTerms = [...parsed.and, ...parsed.orGroups.flat()].map(
            (t) => t.value,
          );
          const order = new Map<string, number>();
          scoreQuery(index, rankTerms.join(" ")).forEach((hit, i) => {
            if (!order.has(hit.path)) order.set(hit.path, i);
          });
          const top = survivors
            .map((rec) => rec.path)
            .sort(
              (a, b) =>
                (order.get(a) ?? Number.MAX_SAFE_INTEGER) -
                  (order.get(b) ?? Number.MAX_SAFE_INTEGER) ||
                a.localeCompare(b),
            )
            .slice(0, RESULT_LIMIT);

          ctx.resultCount = top.length;
          return {
            content: [
              { type: "text" as const, text: await renderHits(backend, top) },
            ],
          };
        } catch (err) {
          ctx.errorCode = "garden_query_failed";
          return respondToolError("garden_query_failed", err);
        }
      },
    ),
  );

  // ── garden_cluster ─────────────────────────────────────────────────────
  server.registerTool(
    "garden_cluster",
    {
      title: "Cluster related notes",
      description:
        "Use this to discover groups of topically-related notes and get a suggested landing/index note for each group. With a seed note, returns 'more like this'; without one, surfaces the vault's natural clusters. SUGGESTS a landing note — never creates one (call garden_plant yourself to create). Triggers: 'what notes are related to X', 'group my notes by topic', 'suggest an index for my IS 7011 notes'.",
      inputSchema: {
        seed: z
          .string()
          .optional()
          .describe(
            "Optional seed note path (or basename) to cluster around. Omit for whole-vault clusters.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        tool: "garden_cluster",
        kind: "read",
        effect: "read",
        workspaceId: opts.workspaceId,
        argsShape: ({ seed }) => ({
          seed_present: seed != null && seed !== "",
        }),
      },
      async ({ seed }, ctx) => {
        try {
          if (!gardenClusterEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_cluster");
          }

          // CL4 invariant: clustering is read-only — it NEVER calls
          // backend.writeFile/delete/move. Landing notes are PROPOSALS only.
          ctx.flags.writes = 0;
          ctx.flags.seed_present = seed != null && seed !== "";

          const index = await getRetrievalIndex(backend);
          const pool = index.files.filter(
            (rec) => !isExcludedFromResults(rec.path),
          );
          const df = clusterDf(pool);
          const maxDf = Math.max(3, Math.floor(pool.length * 0.4));
          const nodes: ClusterNode[] = pool.map((rec) => ({
            rec,
            sig: contentSig(rec, df, maxDf),
            runs: clusterIdRuns(rec),
          }));

          const noResult = (text: string) => {
            ctx.noResults = true;
            ctx.resultCount = 0;
            return { content: [{ type: "text" as const, text }] };
          };

          // ── Seeded: "more like this" around one note ──
          if (seed != null && seed !== "") {
            const base = path.basename(seed, ".md");
            const seedNode =
              nodes.find((n) => n.rec.path === seed) ??
              nodes.find((n) => path.basename(n.rec.path, ".md") === base);
            if (!seedNode) {
              return noResult(`No note matching seed \`${seed}\`.`);
            }
            const members = nodes
              .filter(
                (n) =>
                  n.rec.path !== seedNode.rec.path &&
                  clusterRelated(seedNode, n),
              )
              .map((n) => n.rec.path)
              .sort()
              .slice(0, CLUSTER_MEMBER_MAX);
            if (members.length === 0) {
              return noResult(
                `No related notes found for \`${seedNode.rec.path}\`.`,
              );
            }
            ctx.flags.cluster_count = 1;
            ctx.flags.largest_cluster_size = members.length;
            ctx.resultCount = members.length;
            const titleRecs = [
              seedNode.rec,
              ...members.map((p) => nodes.find((n) => n.rec.path === p)!.rec),
            ];
            return {
              content: [
                {
                  type: "text" as const,
                  text: renderCluster(titleRecs, members, df),
                },
              ],
            };
          }

          // ── Unseeded: connected components under the related() relation ──
          const scanned = nodes.slice(0, CLUSTER_SCAN_CAP);
          const truncated = nodes.length - scanned.length;
          const parent = scanned.map((_, i) => i);
          const find = (i: number): number => {
            while (parent[i] !== i) {
              parent[i] = parent[parent[i]];
              i = parent[i];
            }
            return i;
          };
          const union = (a: number, b: number) => {
            parent[find(a)] = find(b);
          };
          for (let i = 0; i < scanned.length; i++) {
            for (let j = i + 1; j < scanned.length; j++) {
              if (clusterRelated(scanned[i], scanned[j])) union(i, j);
            }
          }
          const groups = new Map<number, ClusterNode[]>();
          for (let i = 0; i < scanned.length; i++) {
            const root = find(i);
            (groups.get(root) ?? groups.set(root, []).get(root)!).push(
              scanned[i],
            );
          }
          const clusters = [...groups.values()]
            .filter((g) => g.length >= 2) // singletons dropped
            .sort((a, b) => b.length - a.length)
            .slice(0, CLUSTER_MAX);

          if (clusters.length === 0) {
            return noResult(
              "No clusters found — no notes are closely related.",
            );
          }
          ctx.flags.cluster_count = clusters.length;
          ctx.flags.largest_cluster_size = clusters[0].length;
          ctx.resultCount = clusters.length;

          const blocks = clusters.map((g) => {
            const recs = g.map((n) => n.rec);
            const members = recs
              .map((r) => r.path)
              .sort()
              .slice(0, CLUSTER_MEMBER_MAX);
            return renderCluster(recs, members, df);
          });
          const header = `Found ${clusters.length} related-note ${
            clusters.length === 1 ? "cluster" : "clusters"
          }.${truncated > 0 ? ` (Scanned the first ${scanned.length} of ${nodes.length} notes; ${truncated} not clustered this pass.)` : ""}`;
          return {
            content: [
              { type: "text" as const, text: [header, ...blocks].join("\n\n") },
            ],
          };
        } catch (err) {
          ctx.errorCode = "garden_cluster_failed";
          return respondToolError("garden_cluster_failed", err);
        }
      },
    ),
  );

  // ── garden_backlinks (v2 — stored extracted_outlinks column) ─────────────
  // Reads the column written at WRITE time (extractOutlinks → extracted_outlinks),
  // NOT a per-call full-vault body scan — that derive-on-read shortcut (PR #15)
  // was the bac2d1b 4-13min prod-hang class on the encrypted mirror. Set
  // membership, precision = 1.0: only a literal [[wikilink]] edge counts.
  server.registerTool(
    "garden_backlinks",
    {
      title: "Find notes that link to a target",
      description:
        "Use this to find every note whose body contains a [[wikilink]] pointing at a target note — its inbound links / 'what references this'. Set membership, not ranked relevance; returns ONLY real links — a prose mention that isn't a [[wikilink]] is never a backlink. Triggers: 'what links to X', 'backlinks for X', 'what references my X note', 'inbound links to X'. For a keyword/topic search prefer `garden_find`; for body-text search prefer `garden_forage`.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "The note to find inbound links for — basename or path (e.g. 'module-1-it-competitive-advantage' or 'school/.../module-1.md').",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTelemetry(
      {
        tool: "garden_backlinks",
        kind: "read",
        effect: "read",
        workspaceId: opts.workspaceId,
        argsShape: ({ target }) => ({ target_len: target.length }),
      },
      async ({ target }, ctx) => {
        try {
          if (!gardenBacklinksEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_backlinks");
          }

          const want = linkKey(target);
          if (!want) {
            ctx.noResults = true;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${target}" isn't a resolvable note name.`,
                },
              ],
            };
          }

          // Feature-detect the stored-outlinks reader. A backend without it (or
          // a mock) → honest empty rather than a throw (BL5 posture).
          if (!backend.listFileOutlinksMeta) {
            ctx.noResults = true;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No notes link to "${target}".`,
                },
              ],
            };
          }

          // Column read — paginated, no blob decrypt. Filter to source files
          // whose stored outlink set contains the target key. The TAPROOT-MANAGED
          // root index links to nearly every note, so it is never counted as a
          // backlink SOURCE (precision).
          const meta = await backend.listFileOutlinksMeta();
          const matched: string[] = [];
          const nullOutlinkPaths: string[] = [];
          for (const m of meta) {
            if (isExcludedFromResults(m.path)) continue;
            if (m.outlinks == null) {
              nullOutlinkPaths.push(m.path);
              continue;
            }
            if (m.outlinks.includes(want)) matched.push(m.path);
          }
          matched.sort();

          // Self-healing: any not-yet-extracted rows (migration-day cold tail)
          // backfill fire-and-forget. A partial column yields FEWER hits, never
          // WRONG ones — and the backfill drains the gap so subsequent reads are
          // complete. The deploy-time warm populates the whole column before the
          // read flag flips, so this is the rare-path safety net.
          if (nullOutlinkPaths.length > 0) {
            void backfillNullOutlinks(backend, nullOutlinkPaths).catch((err) =>
              console.error(`[backlinks] outlink backfill failed: ${err}`),
            );
          }

          ctx.flags.backlink_count = matched.length;
          ctx.resultCount = matched.length;

          // BL5 — orphan: honest empty, never confabulated.
          if (matched.length === 0) {
            ctx.noResults = true;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No notes link to "${target}".`,
                },
              ],
            };
          }

          // No silent caps (CLAUDE.md): a hub note can have far more inbound
          // links than RESULT_LIMIT — say so rather than truncating quietly.
          const shown = matched.slice(0, RESULT_LIMIT);
          const rendered = await renderHits(backend, shown);
          const text =
            matched.length > shown.length
              ? `Showing the first ${shown.length} of ${matched.length} notes that link to "${target}" (alphabetical).\n${rendered}`
              : rendered;
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          ctx.errorCode = "garden_backlinks_failed";
          return respondToolError("garden_backlinks_failed", err);
        }
      },
    ),
  );
}
