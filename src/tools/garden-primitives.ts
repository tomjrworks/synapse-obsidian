import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import { respondToolError } from "./_rate-limit.js";
import { withTelemetry } from "../observability/tool-telemetry.js";

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

// Enabled-path logic for all three tools lands in subsequent commits (PLAN §7
// steps 3–5). The stub keeps the ENABLED path honestly RED against the eval
// behavior bars until each handler is implemented.
const NOT_IMPLEMENTED = "garden primitive not implemented yet (scaffold)";
function notImplemented(): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: NOT_IMPLEMENTED }] };
}

export function registerGardenPrimitives(
  server: McpServer,
  backend: StorageBackend,
  opts: { workspaceId?: string; retrievalV2?: boolean } = {},
): void {
  void backend; // index reads land with the handler logic (PLAN §7.3–5)

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
      async ({ identifier: _identifier }, ctx) => {
        try {
          if (!gardenIdentifierEnabled()) {
            ctx.flags.tool_disabled = true;
            return disabledResponse("garden_identifier");
          }
          // TODO(PLAN §7.3): exact-id recall + IDN4 suggest + IDN5 hint.
          ctx.flags.not_implemented = true;
          return notImplemented();
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
