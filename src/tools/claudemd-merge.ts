import {
  MANAGED_SECTION_ORDER,
  SECTION_MARKER_END,
  SECTION_MARKER_START,
  type ManagedSectionId,
  type ManagedSections,
} from "./persona-claudemd.js";

export interface MergeResult {
  merged: string;
  warnings: string[];
  /** Sections whose existing content was replaced. */
  replaced: ManagedSectionId[];
  /** Sections appended at the end because no markers were found. */
  appended: ManagedSectionId[];
}

interface MarkerSpan {
  startIdx: number;
  endIdx: number;
  startLineEnd: number;
  endLineStart: number;
}

/**
 * Locate a complete `<!-- TAPROOT-MANAGED:<id> START -->` ... `END -->`
 * pair in `text`. Returns null if either marker is missing or if END
 * appears before START (malformed). Multiple START markers without an
 * intervening END are also rejected (nested same-id is malformed).
 */
function locateMarkers(text: string, id: ManagedSectionId): MarkerSpan | null {
  const startTag = SECTION_MARKER_START(id);
  const endTag = SECTION_MARKER_END(id);
  const startIdx = text.indexOf(startTag);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(endTag, startIdx + startTag.length);
  if (endIdx === -1) return null;
  // Reject a second START before this END (nested / unclosed pair).
  const dupStart = text.indexOf(startTag, startIdx + startTag.length);
  if (dupStart !== -1 && dupStart < endIdx) return null;
  return {
    startIdx,
    endIdx,
    startLineEnd: startIdx + startTag.length,
    endLineStart: endIdx,
  };
}

/**
 * Merge fresh F-managed section bodies into an existing CLAUDE.md.
 *
 * Contract:
 * - Content OUTSIDE TAPROOT-MANAGED markers is preserved verbatim
 *   (including the user's hand-edits, custom sections, etc.).
 * - Content INSIDE matching START/END markers is replaced with the
 *   corresponding `newSections` body.
 * - When a section's marker pair is missing or malformed, the section
 *   body is appended at the end of the document (wrapped in fresh
 *   markers so future merges can splice it in place).
 * - Section IDs preserved across calls. Order in the output preserves
 *   the existing document's order; appended sections follow
 *   MANAGED_SECTION_ORDER.
 *
 * Warnings surface every malformed-marker situation so the caller
 * (F6 onboarding endpoint) can show the user a "we appended these
 * sections instead of replacing them" notice.
 */
export function mergeIntoExistingClaudeMd(
  existing: string,
  newSections: ManagedSections,
): MergeResult {
  let working = existing;
  const warnings: string[] = [];
  const replaced: ManagedSectionId[] = [];
  const appended: ManagedSectionId[] = [];

  // Replace pass: walk sections in their plan-defined order. We re-locate
  // markers between iterations because earlier replacements shift offsets.
  for (const id of MANAGED_SECTION_ORDER) {
    const span = locateMarkers(working, id);
    if (span) {
      const before = working.slice(0, span.startLineEnd);
      const after = working.slice(span.endLineStart);
      working = `${before}\n${newSections[id]}\n${after}`;
      replaced.push(id);
      continue;
    }
    // Diagnose: was an isolated START or END present? Surface a warning
    // before treating as "no markers, append fresh."
    const startOnly = working.includes(SECTION_MARKER_START(id));
    const endOnly = working.includes(SECTION_MARKER_END(id));
    if (startOnly && !endOnly) {
      warnings.push(
        `Section "${id}": found START marker but no matching END — appending fresh section instead of in-place replace.`,
      );
    } else if (endOnly && !startOnly) {
      warnings.push(
        `Section "${id}": found END marker but no matching START — appending fresh section instead of in-place replace.`,
      );
    } else if (startOnly && endOnly) {
      warnings.push(
        `Section "${id}": markers present but malformed (END before START or nested) — appending fresh section instead of in-place replace.`,
      );
    }
    appended.push(id);
  }

  // Append pass: any section that wasn't located gets appended at end.
  if (appended.length > 0) {
    const trail = working.endsWith("\n") ? "" : "\n";
    const appendedBlocks = appended.map((id) =>
      [SECTION_MARKER_START(id), newSections[id], SECTION_MARKER_END(id)].join(
        "\n",
      ),
    );
    working = `${working}${trail}\n${appendedBlocks.join("\n\n")}\n`;
  }

  return { merged: working, warnings, replaced, appended };
}
