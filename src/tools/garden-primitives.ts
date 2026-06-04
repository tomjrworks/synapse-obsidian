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
 * This commit is the SCAFFOLD: tools registered inert (flag-OFF → disabled;
 * flag-ON → not-implemented stub) so the failing-eval-first baseline can capture
 * tool-present + flag-off RED/GREEN. Handler logic lands in PLAN §7 steps 3–5.
 *
 * PLAN: 2026-06-04-pass-4a-plan. SPEC: 2026-06-04-pass-4a-spec. Gates:
 * 2026-06-04-pass-4-primitives-evals (§2–4 + cross-cutting).
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

// Enabled-path logic for garden_query / garden_cluster lands in PLAN §7.4–5.
// The stub keeps those ENABLED paths honestly RED against the eval behavior
// bars until each handler is implemented.
const NOT_IMPLEMENTED = "garden primitive not implemented yet (scaffold)";
function notImplemented(): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: NOT_IMPLEMENTED }] };
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
      async ({ query: _query }, ctx) => {
        try {
          if (!gardenQueryEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_query");
          }
          // TODO(PLAN §7.4): parse → predicate over ScoringRecord → scoreQuery rank.
          ctx.flags.not_implemented = true;
          return notImplemented();
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
      async ({ seed: _seed }, ctx) => {
        try {
          if (!gardenClusterEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_cluster");
          }
          // TODO(PLAN §7.5): seeded scoreQuery / unseeded Jaccard agglomeration
          // + landing-note proposal. ZERO writes (CL4 invariant).
          ctx.flags.not_implemented = true;
          ctx.flags.writes = 0;
          return notImplemented();
        } catch (err) {
          ctx.errorCode = "garden_cluster_failed";
          return respondToolError("garden_cluster_failed", err);
        }
      },
    ),
  );
}
