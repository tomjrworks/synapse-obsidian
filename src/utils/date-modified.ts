import matter from "gray-matter";

/**
 * Format a Date as `YYYY-MM-DDTHH:MM:SS` in local time, no timezone
 * suffix. Matches the template documented in the generated CLAUDE.md
 * (`src/tools/persona-claudemd.ts`) so frontmatter stays uniform.
 */
function formatLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Detect a leading YAML frontmatter block (the same shape `gray-matter`
 * recognizes: `---\n…\n---\n`). Returns false for plain markdown files
 * — we never auto-create a frontmatter block, only mutate an existing
 * one. See plan `breezy-meandering-phoenix.md` rationale.
 */
function hasFrontmatterBlock(content: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content);
}

/**
 * If `content` has a frontmatter block, return a copy with the
 * `date_modified` field set to `now`. Otherwise return content
 * unchanged. On YAML parse error, return content unchanged + log a
 * warning — never throw, never corrupt user files.
 *
 * Gated externally via `GARDEN_PLANT_DATE_INJECT=1`; this helper itself
 * is side-effect-free aside from the warn log.
 */
export function maybeInjectDateModified(
  content: string,
  opts: { now?: Date } = {},
): string {
  if (!hasFrontmatterBlock(content)) return content;

  const now = opts.now ?? new Date();
  const stamp = formatLocalIso(now);

  try {
    const parsed = matter(content);
    const data = { ...(parsed.data as Record<string, unknown>) };
    data.date_modified = stamp;
    return matter.stringify(parsed.content, data);
  } catch (err) {
    console.warn(
      "[date-modified] Failed to parse frontmatter; leaving file unchanged.",
      err instanceof Error ? err.message : err,
    );
    return content;
  }
}
