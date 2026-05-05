// YAML emit helpers for frontmatter. Hand-rolled (we don't pull js-yaml into
// the emit path — gray-matter's transitive pin isn't a public API). The shape
// here is deliberately a builder, not call-site escape helpers, so future
// fields default into safety.

// Strip C0/C1 control chars + DEL + YAML 1.2 line terminators (NEL U+0085,
// LINE SEPARATOR U+2028, PARAGRAPH SEPARATOR U+2029). js-yaml is forgiving
// here, but stricter downstream parsers (Obsidian renderer, helper-mac sync,
// future Notion mirror) treat these as line breaks → field bleed risk.
const YAML_LINE_TERMS = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;

/** Strip ALL YAML line terminators + control chars. Use for any string that's
 *  about to be embedded in a single-line context (YAML scalar OR markdown
 *  heading). */
export function stripControls(value: string): string {
  return value.replace(YAML_LINE_TERMS, "");
}

/** Escape a string for use INSIDE a YAML double-quoted scalar.
 *  Strips control chars, then escapes \\ before " (order matters — escaping
 *  quotes first would convert `\` into a backslash that then escapes the new
 *  `\"`). */
export function yamlEscape(value: string): string {
  return stripControls(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build a YAML flow-style array. Each value is yamlEscape'd and double-quoted.
 *  Output: `["foo", "bar baz"]` — uniform quoting, parser-equivalent to
 *  unquoted plain scalars but trivially audit-greppable. */
export function safeYamlList(values: readonly string[]): string {
  return "[" + values.map((v) => `"${yamlEscape(v)}"`).join(", ") + "]";
}

type FrontmatterValue = string | number | readonly string[] | undefined;

/** Build a complete `---\n…\n---` YAML frontmatter block from an object.
 *  - string values become double-quoted scalars (`key: "value"`)
 *  - number values are emitted bare (`key: 42`)
 *  - readonly string[] values become safeYamlList output (`key: ["a", "b"]`)
 *  - undefined values are skipped entirely
 *  Order of `---` body matches insertion order of `fields`. */
export function buildFrontmatter(
  fields: Record<string, FrontmatterValue>,
): string {
  const lines: string[] = ["---"];
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    if (typeof val === "number") {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === "string") {
      lines.push(`${key}: "${yamlEscape(val)}"`);
    } else {
      lines.push(`${key}: ${safeYamlList(val)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}
