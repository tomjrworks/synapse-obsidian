import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import { respondToolError } from "./_rate-limit.js";
import { withTelemetry } from "../observability/tool-telemetry.js";
import {
  getRetrievalIndex,
  scoreQuery,
  type RetrievalIndex,
} from "../utils/retrieval-index.js";
import { tokenize, isIdentifierToken } from "../utils/tokenize.js";
import { runsOf } from "../utils/honesty-contract.js";
import { readVaultFile, parseFrontmatter } from "../utils/vault.js";

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
// Two files are "related" if they (a) share a FAMILY identifier run — OR (b)
// clear a content-Jaccard floor on high-signal tokens. A "family run" is the
// narrow case the 4a signal got wrong: the un-gated "any shared run len≥2"
// rule collapsed the real vault (the year `2026` alone bonded 1009/1479 notes,
// every 2-digit calendar/count number bonded hundreds, and the `is` alpha run
// merged every IS-NNNN course). Pass 4b gates the run signal three ways
// (clusterIdRuns + the per-pool DF cap below) so only a genuine code/series
// run (7011, pr) survives. Runs are taken from frontmatter+body ONLY.
const CLUSTER_JACCARD_MIN = 0.25;
const CLUSTER_MAX = 12;
const CLUSTER_MEMBER_MAX = 25;
const CLUSTER_SCAN_CAP = 2000; // O(n²) pairing guard; raised once the over-merge
// was fixed (4a's 500 silently dropped 978 of a 1479-note vault from clustering).
const GENERIC_TOP_FOLDERS = new Set(["daily", "notes", "inbox", "meetings"]);
// Gate 2 (DF cap): a shared run only bonds a family if it is RARE across the
// vault. Common codes (the real vault's 100/200/500, each in hundreds of notes)
// carry no family signal. Cap = max(floor, frac·pool) so it scales but never
// drops below a small-vault floor (a 3-note family must still bond).
const CLUSTER_RUN_DF_FLOOR = 8;
const CLUSTER_RUN_DF_FRAC = 0.08;
// A 4-digit calendar year is never a code. Real course/version codes (7011,
// 7060) are 3+ digits and not year-shaped.
const YEAR_RE = /^(?:19|20)\d\d$/;

interface ClusterNode {
  rec: Rec;
  sig: Set<string>; // high-signal content tokens
  runs: Set<string>; // gated identifier runs (gates 1+3) from frontmatter+body
  familyRuns: Set<string>; // runs surviving the per-pool DF cap (gate 2)
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

/** A numeric run is a CODE (a real family signal) only if it is specific:
 * length ≥ 3 and not a 4-digit calendar year. 2-digit dates/counts (05, 16, 30)
 * and years (2026) are calendar noise — on the real vault they manufactured a
 * giant false family across every dated note. */
function isCodeNumericRun(r: string): boolean {
  return r.length >= 3 && !YEAR_RE.test(r);
}

/**
 * Family runs for a record (gates 1 + 3). For each identifier-shaped token,
 * split into runs and keep only those that can signal a genuine family:
 *   • numeric run  → kept only if it's a CODE (isCodeNumericRun): 7011 ✓,
 *     2026/05/30 ✗. (gate 1 — calendar/short guard)
 *   • alpha run    → kept only if the SAME token carries no numeric code, i.e.
 *     it's a series prefix not a category prefix: pr7 keeps `pr` (1-digit
 *     index), is7011 drops `is` (4-digit course code, else every IS-NNNN
 *     course collapses into one cluster). (gate 3 — alpha suppression)
 * Gate 2 (rare-run DF cap) is applied per-pool by the caller.
 */
function clusterIdRuns(rec: Rec): Set<string> {
  const runs = new Set<string>();
  for (const t of [...rec.frontmatter, ...rec.body]) {
    if (!isIdentifierToken(t)) continue;
    const parts = runsOf(t).filter((r) => r.length >= 2);
    const hasCode = parts.some(isCodeNumericRun);
    for (const r of parts) {
      if (/[0-9]/.test(r)) {
        if (isCodeNumericRun(r)) runs.add(r); // gate 1
      } else if (!hasCode) {
        runs.add(r); // gate 3
      }
    }
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
  for (const r of a.familyRuns) if (b.familyRuns.has(r)) return true; // family
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
            familyRuns: new Set<string>(),
          }));
          // Gate 2: a shared run only bonds a family if it is RARE. Drop runs
          // whose pool DF exceeds the cap (the real vault's 100/200/500-style
          // common codes); keep genuinely scarce codes (7011, pr).
          const runDf = new Map<string, number>();
          for (const n of nodes)
            for (const r of n.runs) runDf.set(r, (runDf.get(r) ?? 0) + 1);
          const runDfCap = Math.max(
            CLUSTER_RUN_DF_FLOOR,
            Math.floor(pool.length * CLUSTER_RUN_DF_FRAC),
          );
          for (const n of nodes) {
            for (const r of n.runs) {
              if ((runDf.get(r) ?? 0) <= runDfCap) n.familyRuns.add(r);
            }
          }

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
}
