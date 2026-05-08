import matter from "gray-matter";

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
