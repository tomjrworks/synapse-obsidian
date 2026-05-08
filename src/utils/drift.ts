import matter from "gray-matter";
import {
  SECTION_MARKER_END,
  SECTION_MARKER_START,
} from "../tools/persona-claudemd.js";
import type { StorageBackend } from "./storage.js";

export type DriftReason =
  | "wrong_folder"
  | "missing_filename_pattern"
  | "missing_required_frontmatter"
  | "structured_record"
  | "multiple";

/**
 * v1 rule kinds. The plan originally specified two rule types
 * ("folder X must use subfolders" + "filename pattern Y"), both
 * extracted from persona-claudemd output. Honest re-read of the
 * persona renderer found only one deterministically-extractable rule
 * — "NEVER create files at vault root" in COMMON_PREAMBLE. Filename
 * pattern enforcement (kebab-case) was scoped out of v1 because the
 * persona's own examples permit dotted basenames (e.g. `node.js-foo`)
 * which a strict kebab regex would flag. v1.5 can add richer rule
 * shapes once persona output gains more machine-readable conventions.
 */
export type Rule = {
  kind: "no-root-files";
  allowlist: string[];
};

/**
 * Folders whose contents are CRM-style structured records, not
 * narrative notes (L7). Files in these folders skip rule checks so
 * a 98-file leads database doesn't trip a "narrative note" rule on
 * every row. v1 uses a small folder-name allowlist; v1.5 can detect
 * structured shape from frontmatter cardinality.
 */
const STRUCTURED_RECORD_FOLDERS = new Set([
  "leads",
  "contacts",
  "customers",
  "companies",
  "prospects",
  "accounts",
]);

const PROTECTED_FILES = new Set(["CLAUDE.md", "index.md"]);

/** Paths that NEVER trigger drift checks. */
function isExempt(path: string): boolean {
  if (PROTECTED_FILES.has(path)) return true;
  if (path.startsWith(".taproot/")) return true;
  if (path.startsWith(".synapse/")) return true;
  return false;
}

function isStructuredRecord(path: string): boolean {
  const parts = path.split("/");
  if (parts.length < 2) return false;
  const parent = parts[parts.length - 2].toLowerCase();
  return STRUCTURED_RECORD_FOLDERS.has(parent);
}

/**
 * Extract the body BETWEEN the named TAPROOT-MANAGED markers. Returns
 * null if either marker is missing (rules embedded in user-edited
 * content outside markers are NOT trusted — those could be hand-edits
 * the user wrote without enforcement intent).
 */
function extractManagedSection(
  content: string,
  id: "filing" | "traits" | "conventions",
): string | null {
  const start = content.indexOf(SECTION_MARKER_START(id));
  if (start === -1) return null;
  const end = content.indexOf(SECTION_MARKER_END(id), start);
  if (end === -1) return null;
  return content.slice(start + SECTION_MARKER_START(id).length, end);
}

/**
 * Parse machine-checkable rules from a CLAUDE.md body. Only reads
 * F-managed sections (between TAPROOT-MANAGED markers) — content the
 * user has hand-edited outside markers is treated as commentary, not
 * enforceable policy.
 */
export function parseRulesFromClaudeMd(content: string): Rule[] {
  const rules: Rule[] = [];
  const filing = extractManagedSection(content, "filing");
  if (filing && /NEVER\s+create\s+files\s+at\s+vault\s+root/i.test(filing)) {
    rules.push({
      kind: "no-root-files",
      allowlist: [...PROTECTED_FILES],
    });
  }
  return rules;
}

export interface RuleCheck {
  violates: boolean;
  rule?: string;
}

/**
 * Pure check: does a vault path violate any of the parsed rules?
 *
 * Skips:
 * - protected files (CLAUDE.md, index.md)
 * - F-managed directories (.taproot/, .synapse/)
 * - structured-record folders (L7)
 */
export function checkPathAgainstRules(
  filePath: string,
  rules: Rule[],
): RuleCheck {
  if (isExempt(filePath)) return { violates: false };
  if (isStructuredRecord(filePath)) return { violates: false };

  for (const r of rules) {
    if (r.kind === "no-root-files") {
      const isRoot = !filePath.includes("/");
      if (isRoot && !r.allowlist.includes(filePath)) {
        return { violates: true, rule: "no-root-files" };
      }
    }
  }
  return { violates: false };
}

const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

interface RulesCacheEntry {
  rules: Rule[];
  cachedAt: number;
}

const rulesCache = new Map<string, RulesCacheEntry>();

/**
 * Cached rules read for a given cacheKey (workspace_id in cloud,
 * "local" in stdio). Re-fetches CLAUDE.md from the backend on cache
 * miss. Returns empty rule set if CLAUDE.md is missing or unreadable —
 * "no rules" is a valid state, not an error.
 */
export async function getRulesForBackend(
  backend: StorageBackend,
  cacheKey: string,
): Promise<Rule[]> {
  const entry = rulesCache.get(cacheKey);
  if (entry && Date.now() - entry.cachedAt < RULES_CACHE_TTL_MS) {
    return entry.rules;
  }
  let rules: Rule[] = [];
  try {
    if (await backend.exists("CLAUDE.md")) {
      const content = await backend.readFile("CLAUDE.md");
      rules = parseRulesFromClaudeMd(content);
    }
  } catch {
    rules = [];
  }
  rulesCache.set(cacheKey, { rules, cachedAt: Date.now() });
  return rules;
}

export function invalidateRulesCache(cacheKey: string): void {
  rulesCache.delete(cacheKey);
}

/**
 * Compute the flags JSONB delta for a vault_files row given a write.
 *
 * CRITICAL: `flags.outside_rules` must be the STRING "true" — the
 * dashboard's getOutsideRulesCount query in agency/taproothq filters
 * `flags->>outside_rules eq 'true'` (string comparison via jsonb ->>
 * operator). A boolean true would never match. Compliance REMOVES the
 * key entirely (rather than writing "false") to keep the C0 partial
 * index `WHERE (flags ? 'outside_rules')` lean.
 *
 * Returns:
 * - `{ set: { outside_rules: "true" } }` on violation
 * - `{ remove: ["outside_rules"] }` on compliance
 * - `null` for exempt paths (no flags update needed)
 */
export interface FlagsUpdate {
  set?: Record<string, string>;
  remove?: string[];
}

const STRUCTURED_RECORD_TYPES = new Set([
  "lead",
  "contact",
  "customer",
  "company",
  "prospect",
  "account",
]);

function isStructuredRecordByFrontmatter(content: string): boolean {
  try {
    const fm = matter(content).data as Record<string, unknown>;
    const typeVal = fm["type"];
    if (typeof typeVal === "string") {
      return STRUCTURED_RECORD_TYPES.has(typeVal.toLowerCase().trim());
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

function classifyViolationReason(
  filePath: string,
  rule: string | undefined,
): { reason: DriftReason; context: string } {
  if (rule === "no-root-files") {
    return {
      reason: "wrong_folder",
      context: "file at vault root; expected subfolder",
    };
  }
  // Future rule kinds (missing_filename_pattern, missing_required_frontmatter)
  // will add their own branches here.
  return { reason: "wrong_folder", context: "" };
}

/**
 * Compute the flags JSONB delta for a vault_files row given a write.
 *
 * CRITICAL: `flags.outside_rules` must be the STRING "true" — the
 * dashboard's getOutsideRulesCount query in agency/taproothq filters
 * `flags->>outside_rules eq 'true'` (string comparison via jsonb ->>
 * operator). A boolean true would never match. Compliance REMOVES the
 * key entirely (rather than writing "false") to keep the C0 partial
 * index `WHERE (flags ? 'outside_rules')` lean.
 *
 * V1.5a.1: extended with `outside_rules_reason` and `outside_rules_context`
 * for richer drift classification. Legacy `outside_rules: "true"` continues
 * to emit on all violations for backward compat with the dashboard banner.
 * Structured-record folders get an informational `structured_record` reason
 * WITHOUT setting `outside_rules` (they are exempt from violation rules).
 *
 * Returns:
 * - violation delta on rule violation
 * - structured-record delta for CRM folders / frontmatter-detected records
 * - compliance delta on clean files
 * - `null` for exempt paths (no flags update needed)
 */
export function computeFlagsUpdate(
  filePath: string,
  content: string | undefined,
  rules: Rule[],
): FlagsUpdate | null {
  if (isExempt(filePath)) return null;

  // Structured-record folders: informational reason, no violation flag.
  if (isStructuredRecord(filePath)) {
    return {
      remove: ["outside_rules"],
      set: { outside_rules_reason: "structured_record" },
    };
  }

  // Frontmatter-detected structured records (type: lead/contact/etc.)
  if (content !== undefined && isStructuredRecordByFrontmatter(content)) {
    return {
      remove: ["outside_rules"],
      set: { outside_rules_reason: "structured_record" },
    };
  }

  const check = checkPathAgainstRules(filePath, rules);
  if (check.violates) {
    const { reason, context } = classifyViolationReason(filePath, check.rule);
    const setObj: Record<string, string> = {
      outside_rules: "true",
      outside_rules_reason: reason,
    };
    if (context) setObj.outside_rules_context = context.slice(0, 200);
    return { set: setObj };
  }

  return {
    remove: ["outside_rules", "outside_rules_reason", "outside_rules_context"],
  };
}

/**
 * Merge a FlagsUpdate delta into an existing flags JSONB value.
 * Returns the new flags object to write, or null if no write is needed
 * (delta was null OR delta would not change the existing value).
 */
export function mergeFlags(
  existing: Record<string, unknown>,
  delta: FlagsUpdate | null,
): Record<string, unknown> | null {
  if (!delta) return null;
  const next: Record<string, unknown> = { ...existing };
  let changed = false;
  if (delta.set) {
    for (const [k, v] of Object.entries(delta.set)) {
      if (next[k] !== v) {
        next[k] = v;
        changed = true;
      }
    }
  }
  if (delta.remove) {
    for (const k of delta.remove) {
      if (k in next) {
        delete next[k];
        changed = true;
      }
    }
  }
  return changed ? next : null;
}
