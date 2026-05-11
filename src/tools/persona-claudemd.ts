/**
 * CLAUDE.md composer for taproot_setup_scan / persona-render.
 *
 * Replaces the prior trait-template system (Founder/Life-OS/Student/etc.)
 * with universal scaffolding + observed-folder output. See:
 *   - ~/Desktop/vault/Tom's Vault/decisions/2026-05-10-taproot-claudemd-folder-scan-not-traits.md
 *   - ~/.claude/plans/rip-traits-from-setup-scan.md
 *
 * Locked decisions (verbatim):
 *   L1. Folder summaries: rule-based, no LLM. Caller provides FolderSummary[].
 *   L4. Rollback gate: TAPROOT_TRAITS_ENABLED=1 → legacy trait path.
 *   L5. Three-state classifier for existing CLAUDE.md (fresh / managed / user-owned).
 *   L7. Starter scaffold only when folderScan is empty.
 *   L8. Universal filing decision tree emitted verbatim every render.
 *
 * The legacy MCP path (generateClaudeMd in ./init.ts) is intentionally
 * untouched; it uses a purpose-based model and is scheduled for separate
 * deprecation.
 */
import type { FolderSummary } from "../utils/folder-scan.js";
import { composeLegacyTraitSections } from "./persona-claudemd-legacy.js";

export type ManagedSectionId = "filing" | "traits" | "conventions";

export const MANAGED_SECTION_ORDER: ManagedSectionId[] = [
  "filing",
  "traits",
  "conventions",
];

export interface ManagedSections {
  filing: string;
  traits: string;
  conventions: string;
}

export const SECTION_MARKER_START = (id: ManagedSectionId) =>
  `<!-- TAPROOT-MANAGED:${id} START -->`;
export const SECTION_MARKER_END = (id: ManagedSectionId) =>
  `<!-- TAPROOT-MANAGED:${id} END -->`;

// ─────────────────────────────────────────────────────────────────────────
// Universal scaffolding constants (Step 1 / L8).
// Emitted verbatim every render, regardless of vault state.
// ─────────────────────────────────────────────────────────────────────────

const WHAT_THIS_VAULT_IS = `## What this vault is

This is your memory layer. You (the AI) read it, write to it, and keep it organized. The user directs strategy; you execute.

- All content is markdown — portable, future-proof, human-readable.
- Obsidian renders these files — use \`[[wikilinks]]\` to connect ideas.
- Every interaction should leave the vault better than you found it.`;

const READ_FIRST_PREAMBLE = `## Read FIRST (before every answer)

**BLOCKING:** Before answering questions about the user's projects, past decisions, or anything that may already live in the vault — search the vault first. It has context that general knowledge will miss.

1. Read \`index.md\` to see what's catalogued.
2. Search relevant folders for prior notes on the topic.
3. Read the most relevant pages before responding.
4. Cite sources with \`[[wikilinks]]\` when drawing from vault content.

This applies to every conversation. The vault is the source of truth.`;

const FILING_DECISION_TREE = `## Filing decision tree

When the user asks you to save something, decide the path in this order:

1. **Explicit user direction wins.** If the user says "save this to \`<folder>\`," use that path. Create the folder if it doesn't exist.
2. **Match a learned filing rule** (see the Learned filing rules section below). If a rule applies, file there. You can create new subfolders within the matched top-level folder (e.g., \`research/ai-tools/\` if researching AI tools and no subfolder exists yet). Announce it: "Saved to \`research/ai-tools/foo.md\`. Created new folder \`research/ai-tools/\`."
3. **Top-level theme match, no subfolder.** If content fits a top-level folder above but no specific subfolder exists, create a sensibly-named new subfolder under the best-fit parent. Same announcement pattern.
4. **No clear home.** File to \`inbox/\` with frontmatter \`suggested-folder: <best-guess>\`. Tell the user: "Saved to \`inbox/foo.md\`. Best guess: \`research/something-or-other\`. Move it when you're sure."
5. **NEVER create a new TOP-LEVEL folder silently.** If you think the vault needs a new top-level category, ASK the user first: "I'd suggest a new top-level folder \`<name>/\` for this kind of note. Create it?" New top-level folders should be deliberate, not accidental.

**Why:** without the inbox fallback + the explicit "no top-level silent creation" rule, vaults drift. Three different sessions create \`articles/\`, \`saved/\`, and \`bookmarks/\` for the same kind of content. The inbox absorbs the indecision; the user sorts it later.`;

const MASTER_INDEX_INSTRUCTIONS = `## Master index

\`index.md\` lives at vault root. It's a catalog of every note with a one-line summary.

- **Read \`index.md\` first** when searching the vault — faster than globbing folders, and surfaces notes whose filenames don't obviously match.
- **Update \`index.md\` after every write.** When you create a new note OR significantly update an existing one, add/revise its entry. Format: \`- [[<wikilink>]] — <one-line summary>\`, under 100 characters. File the entry under the matching \`## <Folder>/\` section header.
- **Don't update the index for trivial edits** (typo fixes, formatting, single-line additions). Use judgment: if the note's purpose or scope changed, revise the index line; otherwise leave it.
- **Keep it scannable.** Sectioned bullet lists only. No prose paragraphs. No emoji. No dumping raw frontmatter into the one-liner.`;

const ARCHIVED_RULES = `## Marking dead / superseded content

When a topic is abandoned, a strategy changes, or information becomes obsolete:

1. Add \`status: archived\` (or \`status: killed\`) to the frontmatter.
2. Add a bold line at the top: **⚠️ ARCHIVED (YYYY-MM-DD) — [reason].**
3. Update \`index.md\` — append "(ARCHIVED)" to the one-line summary.

Never delete dead content — it has historical value. Just mark it clearly so searches don't surface it as active.`;

const WRITE_AUTOMATICALLY = `## Write AUTOMATICALLY (don't wait to be asked)

Don't wait until the end of a conversation to save things. Write to the vault **after each meaningful exchange**:

- **Research answers:** When you synthesize an answer worth keeping, save it to \`research/<subfolder>/\`.
- **New insights or decisions:** Log decisions in \`decisions/\` with a YYYY-MM-DD prefix; log half-baked ideas in \`ideas/\`.
- **Session logs:** After major milestones (research completed, decision made, milestone shipped), write a daily note in \`daily/YYYY-MM-DD-<topic>.md\`.
- **Update the index:** After creating any new note, update \`index.md\` with a one-line summary under the matching \`## <Folder>/\` section.
- **Connect ideas:** Add \`[[wikilinks]]\` to link related notes whenever you create or update content.

**Don't log:** trivial questions, quick fixes, or exchanges with no lasting value.`;

const CONVENTIONS_UNIVERSAL = `## Conventions (universal)

- Filenames: lowercase-kebab-case (e.g., \`active-inference.md\`).
- Date format: YYYY-MM-DD.
- Keep notes atomic — one idea per note when possible.
- Use \`[[wikilinks]]\` for all internal cross-references. Link the first mention of a concept per section, not every mention.
- **Never leave a \`[[wikilink]]\` pointing to nothing** — always create at least a stub.
- Every page SHOULD have YAML frontmatter:

\`\`\`yaml
---
title: "Page Title"
date_created: YYYY-MM-DD
date_modified: YYYY-MM-DD
summary: "One-line description"
tags: [relevant-tags]
---
\`\`\``;

const WRITING_STYLE = `## Writing style

- Direct, no fluff.
- Bullet points over paragraphs.
- Include the *why* behind decisions, not just the *what*.
- Link related notes with \`[[wikilinks]]\`.`;

const COMPOUNDING_LOOP = `## Compounding knowledge loop

When synthesizing research or answering questions:

1. **Search the vault first** for prior answers on the topic.
2. **If a note on this topic already exists — update it in place.** Don't create a duplicate.
   - Add a dated section at the top with the new information.
   - Mark superseded sections with ~~strikethrough~~ or move to a "## Previous" section.
   - One note per topic = single source of truth.
3. If no prior note exists, create one in the appropriate folder (see filing rules above).
4. Update \`index.md\` with the new or updated entry.
5. Link back to related notes with \`[[wikilinks]]\`.

### Handling contradictions

- **When new info contradicts an existing note:** update the existing note. Don't leave two notes that say different things.
- **When two existing notes conflict:** add ⚠️ to the stale one with a link to the current one. Update or merge.
- **Always prefer recency.** When vault content conflicts, the most recently modified note wins — but verify it's not just newer-but-wrong.
- **Decisions override research.** If a \`decisions/\` note says "we chose X" and a \`research/\` note still argues for Y, the decision stands.`;

const SELF_UPDATING = `## Self-updating instructions

If the user expresses a preference about how they like work done — file naming, writing style, what to log, what not to log, folder organization — **update this CLAUDE.md file to reflect it.** These instructions should evolve to match how the user actually works. Add concrete rules to the **Learned filing rules** section above when a filing pattern crystallizes.`;

/**
 * L7: starter scaffold emitted only when the folder-scan returns nothing.
 * Not physically created on disk — listed so the filing decision tree has
 * names to match against. Folders get created on first save into them.
 */
const STARTER_FOLDERS: FolderSummary[] = [
  { name: "daily", summary: "session logs and dated notes" },
  { name: "decisions", summary: "dated decisions with reasoning" },
  {
    name: "inbox",
    summary: "landing pad for notes that don't have a clear home yet",
  },
  { name: "notes", summary: "misc one-off notes" },
  { name: "projects", summary: "active work, one subfolder per project" },
];

const LEARNED_RULES_PLACEHOLDER = "(none yet)";

// ─────────────────────────────────────────────────────────────────────────
// Classifier (L5).
// ─────────────────────────────────────────────────────────────────────────

export type ClaudeMdState = "fresh" | "taproot_managed" | "user_owned";

const FRESH_CHAR_FLOOR = 50;

/**
 * Three-state classification for an existing (or absent) CLAUDE.md.
 *
 * - `fresh` → absent OR <=50 chars trimmed (covers Obsidian default placeholders).
 * - `taproot_managed` → contains any TAPROOT-MANAGED:<id> START marker.
 * - `user_owned` → substantive content, no markers. Never clobber.
 */
export function classifyClaudeMdContent(
  content: string | null | undefined,
): ClaudeMdState {
  if (content == null) return "fresh";
  if (content.trim().length <= FRESH_CHAR_FLOOR) return "fresh";
  if (
    /<!--\s*TAPROOT-MANAGED:(filing|traits|conventions)\s+START\s*-->/.test(
      content,
    )
  ) {
    return "taproot_managed";
  }
  return "user_owned";
}

// ─────────────────────────────────────────────────────────────────────────
// Composers (Step 3).
// ─────────────────────────────────────────────────────────────────────────

export interface ComposePersonaSectionsInput {
  folderScan?: FolderSummary[];
  today?: string;
  learnedRules?: string[];
}

function renderFolderList(folders: FolderSummary[]): string {
  return folders.map((f) => `- \`${f.name}/\` — ${f.summary}`).join("\n");
}

function renderVaultFoldersBlock(folderScan: FolderSummary[]): string {
  // Always emit the 5 starter folders with their canonical summaries —
  // they exist on disk from helper-mac StarterFolders.ensure even when
  // the cloud-side scan doesn't see them (empty folders aren't object-
  // visible in Supabase Storage). For starter folders that DO appear in
  // the scan, the canonical summary still wins so we don't surface a
  // random inbox note's first line as the folder's purpose. Non-starter
  // observed folders append below the starters.
  const starterNames = new Set(STARTER_FOLDERS.map((f) => f.name));
  const observedNonStarters = folderScan.filter(
    (f) => !starterNames.has(f.name),
  );
  const folders: FolderSummary[] = [...STARTER_FOLDERS, ...observedNonStarters];
  const lines: string[] = [
    "## Vault folders",
    "",
    "These are your top-level folders. The 5 starter folders come pre-scaffolded; new top-level folders are deliberate — ask before creating one.",
    "",
    renderFolderList(folders),
    "",
    "**Vault root.** Only `CLAUDE.md` and `index.md` live at vault root. **NEVER create files at vault root** — file under one of the folders above.",
  ];
  return lines.join("\n");
}

function renderLearnedRulesBlock(learnedRules: string[]): string {
  const lines: string[] = ["## Learned filing rules", ""];
  lines.push(
    "When the same kind of content is filed to the same place 3+ times, add a rule here. Ask the user once before adding; on yes, splice it in.",
    "",
  );
  if (learnedRules.length === 0) {
    lines.push(LEARNED_RULES_PLACEHOLDER);
  } else {
    lines.push(...learnedRules.map((r) => `- ${r}`));
  }
  return lines.join("\n");
}

export function composePersonaSections(
  opts: ComposePersonaSectionsInput,
): ManagedSections {
  const today = opts.today ?? new Date().toISOString().split("T")[0];
  const folderScan = opts.folderScan ?? [];
  const learnedRules = opts.learnedRules ?? [];

  const filing = [
    `# CLAUDE.md\n\n> Created ${today} | Taproot memory layer`,
    WHAT_THIS_VAULT_IS,
    READ_FIRST_PREAMBLE,
    renderVaultFoldersBlock(folderScan),
    FILING_DECISION_TREE,
    MASTER_INDEX_INSTRUCTIONS,
    ARCHIVED_RULES,
    WRITE_AUTOMATICALLY,
  ].join("\n\n");

  const traits = renderLearnedRulesBlock(learnedRules);

  const conventions = [
    CONVENTIONS_UNIVERSAL,
    WRITING_STYLE,
    COMPOUNDING_LOOP,
    SELF_UPDATING,
  ].join("\n\n");

  return { filing, traits, conventions };
}

/**
 * Compose the full marker-wrapped CLAUDE.md.
 *
 * L4: TAPROOT_TRAITS_ENABLED=1 routes to the legacy trait composer for
 * one release window (0.2.0 → 0.2.1). The wizard removes the trait step
 * unconditionally — rollback degrades to universal scaffolding only.
 */
export interface ComposePersonaClaudeMdInput extends ComposePersonaSectionsInput {
  /** Used only by the legacy rollback path. */
  legacyTraits?: string[];
}

export function composePersonaClaudeMd(
  opts: ComposePersonaClaudeMdInput = {},
): string {
  if (process.env.TAPROOT_TRAITS_ENABLED === "1") {
    return composeLegacyTraitSections({
      traits: opts.legacyTraits ?? [],
      today: opts.today,
    });
  }

  const sections = composePersonaSections(opts);
  const blocks = MANAGED_SECTION_ORDER.map((id) =>
    [SECTION_MARKER_START(id), sections[id], SECTION_MARKER_END(id)].join("\n"),
  );
  return blocks.join("\n\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────
// Test access.
// ─────────────────────────────────────────────────────────────────────────

export const _internal = {
  FILING_DECISION_TREE,
  STARTER_FOLDERS,
  LEARNED_RULES_PLACEHOLDER,
  FRESH_CHAR_FLOOR,
  renderVaultFoldersBlock,
  renderLearnedRulesBlock,
};
