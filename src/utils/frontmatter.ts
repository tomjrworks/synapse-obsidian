import matter from "gray-matter";
import { tokenize, tokenizeWithCounts, isIdentifierToken } from "./tokenize.js";

export const FIRST_CLASS_FIELDS = [
  "tags",
  "status",
  "type",
  "created",
  "summary",
] as const;

export type Cardinality = {
  tags?: string[];
  status?: string;
  type?: string;
  created?: string;
  summary?: string;
  custom: Record<string, unknown>;
};

export function extractCardinality(content: string): Cardinality {
  try {
    const parsed = matter(content);
    const fm = parsed.data as Record<string, unknown>;

    let tags: string[] | undefined;
    const rawTags = fm["tags"];
    if (rawTags !== undefined && rawTags !== null) {
      if (Array.isArray(rawTags)) {
        const normalized = [
          ...new Set(rawTags.map((t) => String(t).toLowerCase())),
        ];
        if (normalized.length > 0) tags = normalized;
      } else if (typeof rawTags === "string" && rawTags.trim()) {
        tags = [rawTags.toLowerCase().trim()];
      }
    }

    let status: string | undefined;
    if (typeof fm["status"] === "string" && fm["status"].trim()) {
      status = fm["status"].trim();
    }

    let type: string | undefined;
    if (typeof fm["type"] === "string" && fm["type"].trim()) {
      type = fm["type"].trim();
    }

    let created: string | undefined;
    const rawCreated = fm["created"] ?? fm["date"];
    if (rawCreated !== undefined && rawCreated !== null) {
      if (rawCreated instanceof Date) {
        created = rawCreated.toISOString().split("T")[0];
      } else if (typeof rawCreated === "string" && rawCreated.trim()) {
        created = rawCreated.trim();
      } else if (typeof rawCreated === "number") {
        const d = new Date(rawCreated);
        if (!isNaN(d.getTime())) {
          created = d.toISOString().split("T")[0];
        }
      }
    }

    let summary: string | undefined;
    if (typeof fm["summary"] === "string" && fm["summary"].trim()) {
      summary = fm["summary"].trim();
    }

    const FIRST_CLASS_SET = new Set([
      "tags",
      "status",
      "type",
      "created",
      "date",
      "summary",
    ]);
    const custom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (!FIRST_CLASS_SET.has(k)) {
        custom[k] = v;
      }
    }

    return { tags, status, type, created, summary, custom };
  } catch {
    console.warn(
      "[frontmatter] Failed to parse frontmatter; returning empty cardinality",
    );
    return { custom: {} };
  }
}

const CUSTOM_VISIBLE_CAP = 3;

export function renderCardinalityLine(card: Cardinality): string {
  const segments: string[] = [];

  if (card.tags && card.tags.length > 0) {
    segments.push(`tags: ${card.tags.join(", ")}`);
  }
  if (card.status) {
    segments.push(`status: ${card.status}`);
  }
  if (card.type) {
    segments.push(`type: ${card.type}`);
  }
  if (card.created) {
    segments.push(`created: ${card.created}`);
  }
  if (card.summary) {
    segments.push(`summary: ${card.summary}`);
  }

  const customEntries = Object.entries(card.custom).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  const visibleCustom = customEntries.slice(0, CUSTOM_VISIBLE_CAP);
  const hiddenCount = customEntries.length - visibleCustom.length;

  for (const [k, v] of visibleCustom) {
    segments.push(`${k}: ${String(v)}`);
  }
  if (hiddenCount > 0) {
    segments.push(`+${hiddenCount} more`);
  }

  if (segments.length === 0) return "";
  return `[${segments.join(" | ")}]`;
}

export const MANAGED_INDEX_MARKER = "TAPROOT-MANAGED:index";

// Pre-bake H1 / first-body-line fallback into card.summary at write time so
// the stored cardinality renders identically to the legacy live-read path
// in buildFileEntry (which used extractFirstH1 / stripFrontmatter fallbacks).
// Without this, files without a `summary:` frontmatter field would regress
// to "(no description)" in the index after migration.
export function enrichCardinalitySummary(
  card: Cardinality,
  rawContent: string,
): Cardinality {
  if (card.summary) return card;
  const h1Match = /^#\s+(.+)$/m.exec(rawContent);
  if (h1Match) return { ...card, summary: h1Match[1].trim().slice(0, 200) };
  // \r?\n so CRLF files don't escape frontmatter stripping
  const body = rawContent.replace(/^---[\s\S]*?---\r?\n/, "").trim();
  const firstLine = body
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("#"));
  if (firstLine) return { ...card, summary: firstLine.trim().slice(0, 200) };
  return card;
}

// ─────────────────────────────────────────────────────────────────────────
// Pass 3 retrieval — per-file token extraction (SPEC §2.2). Written into the
// `extracted_tokens` JSONB column at the same point as extracted_cardinality
// (write hook + loadIndexData backfill), read back in one SELECT, and assembled
// into the inverted index by the pure scoring module (retrieval-index.ts).
//
// CONTENT-derived only: filename + folder tokens are derived from the live PATH
// at index-build time (move-safe — a rename never leaves stale filename tokens
// in the column), so they are NOT stored here. The stored record is the three
// content fields below; buildIndex() adds filename/folder from the path.
// ─────────────────────────────────────────────────────────────────────────

/** Max distinct NON-identifier body tokens kept per file (bounds column payload,
 * SPEC §2.2). Every identifier-shaped token is retained regardless of the cap —
 * identifiers are the high-precision signal; frequency culling must never drop
 * `7011`. */
export const BODY_TOKEN_CAP = 200;

export type FileTokens = {
  /** Tokens of frontmatter title + tags + summary + type. */
  frontmatter: string[];
  /** Deduped body tokens: top BODY_TOKEN_CAP non-identifier by descending
   * frequency, PLUS every identifier-shaped token. */
  body: string[];
  /** Identifier-shaped tokens across frontmatter + body (digit-bearing). Drives
   * the §2.4 precision multiplier and guarantees identifier retention. */
  identifiers: string[];
};

// Collapse frontmatter title/tags/summary/type into one tokenizable string.
function frontmatterText(fm: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) push(x);
    } else {
      parts.push(String(v));
    }
  };
  push(fm["title"]);
  push(fm["tags"]);
  push(fm["summary"]);
  push(fm["type"]);
  return parts.join(" ");
}

// Body tokens with the frequency cap applied. Identifiers always kept.
function capBodyTokens(text: string): {
  body: string[];
  identifiers: string[];
} {
  const counts = tokenizeWithCounts(text);
  const distinct = [...counts.keys()];
  const identifiers = distinct.filter(isIdentifierToken);
  const nonIdentifier = distinct
    .filter((t) => !isIdentifierToken(t))
    // Descending frequency; stable sort preserves first-occurrence order on
    // ties (V8 Array.sort is stable) → deterministic output.
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    .slice(0, BODY_TOKEN_CAP);
  return { body: [...nonIdentifier, ...identifiers], identifiers };
}

/**
 * Extract the per-file content token record for the retrieval index (SPEC §2.2).
 * Pure; safe on malformed frontmatter (falls back to tokenizing raw content as
 * body so a YAML typo never silently drops a note's recall).
 */
export function extractTokens(content: string): FileTokens {
  if (!content) return { frontmatter: [], body: [], identifiers: [] };
  try {
    const parsed = matter(content);
    const fm = parsed.data as Record<string, unknown>;
    const frontmatter = tokenize(frontmatterText(fm));
    const { body, identifiers: bodyIds } = capBodyTokens(parsed.content ?? "");
    const identifiers = [
      ...new Set([...frontmatter.filter(isIdentifierToken), ...bodyIds]),
    ];
    return { frontmatter, body, identifiers };
  } catch {
    // Malformed frontmatter — don't lose body recall; tokenize raw content.
    const { body, identifiers } = capBodyTokens(content);
    return { frontmatter: [], body, identifiers };
  }
}
