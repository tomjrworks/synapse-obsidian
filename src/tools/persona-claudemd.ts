/**
 * Multi-trait persona CLAUDE.md composer for the Stage 1 onboarding wizard.
 *
 * Called by GET /api/persona/claudemd to produce the personalized CLAUDE.md
 * the helper writes to a new user's vault on first-run scaffold. Composes:
 *
 *   1. Common preamble (vault layout, filing decision tree, master index)
 *   2. User's stated context (if personaFreetext non-empty)
 *   3. Trait sections — one per element of traits[], in the order picked
 *   4. Universal conventions tail
 *
 * Content drafted in [[projects/synapse/2026-04-26-taproot-persona-claudemd-templates]].
 * Ships as defaults; users can edit their own CLAUDE.md anytime — the helper
 * writes once at signup and never overwrites.
 *
 * The legacy MCP path (taproot_till / taproot_sow → generateClaudeMd in
 * ./init.ts) is intentionally untouched: it uses a purpose-based content
 * model with custom folder names. The wizard path is trait-based with the
 * default skeleton folders hardcoded.
 */

export type TraitId =
  | "founder"
  | "writer-researcher"
  | "creator-designer"
  | "salesperson"
  | "student"
  | "life-os"
  | "professional-services";

export const ALL_TRAITS: TraitId[] = [
  "founder",
  "writer-researcher",
  "creator-designer",
  "salesperson",
  "student",
  "life-os",
  "professional-services",
];

export function isTraitId(s: string): s is TraitId {
  return (ALL_TRAITS as string[]).includes(s);
}

/**
 * Trait → headers added to the index.md stub on top of the universal set.
 * Used by /api/persona/index-stub. Ordering within an entry preserves the
 * order they should appear in the rendered index.
 */
export const TRAIT_INDEX_HEADERS: Record<TraitId, string[]> = {
  founder: ["Meetings", "Metrics", "Playbook"],
  "writer-researcher": ["Drafts", "Published", "Quotes"],
  "creator-designer": ["Inspiration", "Process", "Assets", "Clients"],
  salesperson: ["Accounts", "Deals", "Playbooks", "Competitive"],
  student: ["Courses", "Assignments", "Exams", "Papers", "Concepts"],
  "life-os": ["Journal", "Goals", "Habits", "Books", "People", "Reflections"],
  "professional-services": [
    "Clients",
    "Proposals",
    "Contracts",
    "Templates",
    "Time",
  ],
};

/**
 * Trait → CLAUDE.md section body. Each value is the markdown for that
 * trait's section, including the leading `## <Title>` header. Composed
 * verbatim into the rendered CLAUDE.md, separated by blank lines.
 */
const TRAIT_SECTIONS: Record<TraitId, string> = {
  founder: `## Founder

You're building a company. Notes serve product decisions, customer development, investor relations, and team operations. Captured well, the vault becomes the company's institutional memory.

### Folders (added on top of the default skeleton)
- \`decisions/\` — architectural, hiring, pricing, strategy. One file per decision: \`YYYY-MM-DD-<topic>.md\` with reasoning.
- \`meetings/\` — investor calls, customer interviews, candidate interviews, board prep. Subfolders: \`meetings/investors/\`, \`meetings/customers/\`, \`meetings/candidates/\`.
- \`metrics/\` — north-star, OKRs, weekly review snapshots.
- \`playbook/\` — repeatable processes (sales, hiring, fundraising, onboarding).

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "decided we're going to..." / "we settled on..." | \`decisions/\` | \`YYYY-MM-DD-<topic>.md\` |
| "investor call with X" / "talked to investor" | \`meetings/investors/\` | \`YYYY-MM-DD-<investor-name>.md\` |
| "customer interview with X" / "user research with" | \`meetings/customers/\` | \`YYYY-MM-DD-<company-or-name>.md\` |
| "candidate interview" | \`meetings/candidates/\` | \`YYYY-MM-DD-<name>-<role>.md\` |
| "this week's metrics" / "weekly review" | \`metrics/\` | \`YYYY-Wnn.md\` |
| "playbook for X" / "how we do X" | \`playbook/\` | \`<process-name>.md\` |
| New initiative (product launch, big project) | \`projects/<project>/\` | folder + \`<project>.md\` entry point |

### Context
- Decisions are first-class. When the user mentions a tradeoff resolved, ALWAYS offer to log it in \`decisions/\`.
- Customer interviews compound. Pull from \`meetings/customers/\` before answering "what are users saying about X."
- Investor updates are usually monthly. If the user asks "what should I send investors this month," pull from \`metrics/\`, recent \`decisions/\`, and recent \`meetings/\`.
- Pivots get a new top-level decision note + status updates on every affected \`projects/<project>/<project>.md\` entry point.
- Project entry points must stay current. After any session that changes project direction, offer to update the entry point.`,

  "writer-researcher": `## Writer-Researcher

You write for a living — long-form pieces, research-heavy work, or both. Notes serve drafts, source management, and the slow accumulation of a body of thought.

### Folders (added on top of the default skeleton)
- \`research/<topic>/\` — deep dives, organized by subject area. One subfolder per ongoing research thread, with \`<topic>.md\` as the entry point.
- \`references/<source-type>/\` — saved articles, book excerpts, paper notes. One file per source. Frontmatter includes \`author\`, \`published\`, \`url\`, \`accessed\`.
- \`drafts/\` — works in progress. Subfolder per piece: outline → draft v1 → draft v2 → review.
- \`published/\` — finished pieces with completion dates.
- \`quotes/\` — extracted quotes, chronologically. Each entry links back to its source in \`references/\`.

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "save this article" / "save this URL" | \`references/<topic>/\` | \`<source-title>.md\` with citation frontmatter |
| "I'm researching X" / starts a new investigation | \`research/<topic>/\` | new subfolder + \`<topic>.md\` entry point |
| "outline for X" / "draft of X" | \`drafts/<piece>/\` | \`outline.md\`, \`draft-v1.md\`, etc. |
| "great quote from X" | \`quotes/\` | \`YYYY-MM-DD-<source-slug>.md\`, link to source |
| "published" / "submitted" | move from \`drafts/\` → \`published/\` | preserve the draft history |

### Citation conventions
Every reference note includes frontmatter:
\`\`\`yaml
author: <name>
published: <YYYY-MM-DD or YYYY>
url: <link>
accessed: <YYYY-MM-DD>
type: article | paper | book | podcast | talk
\`\`\`

### Context
- When user asks "what have I read about X," search \`references/\` first, then \`research/\`.
- When user is drafting, surface relevant quotes from \`quotes/\` proactively.
- Long research threads benefit from a topic entry-point note. If \`research/<topic>/<topic>.md\` is missing, offer to create one summarizing the thread.
- Citation discipline matters — never save an article without capturing source metadata in frontmatter.
- Drafts evolve. Keep version history (\`draft-v1.md\`, \`draft-v2.md\`) rather than overwriting. Cheap, useful for diffing later.`,

  "creator-designer": `## Creator-Designer

You make things — visual, written, or built. Notes serve project management, inspiration, and the slow accumulation of a personal aesthetic.

### Folders (added on top of the default skeleton)
- \`projects/<project>/\` — one folder per active project. Each gets a \`<project>.md\` entry point with brief, status, deliverables.
- \`inspiration/<theme>/\` — saved references, mood boards (described in text), screenshots described via your AI client's vision capability.
- \`process/\` — design decisions, iteration history, "why we landed on X."
- \`assets/\` — non-binary asset references (links to Figma files, Dropbox folders, etc.). Taproot stores text only.
- \`clients/<client>/\` (if doing client work) — one folder per client, with project history + contacts.

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "save this design" / "this is great inspiration" | \`inspiration/<theme>/\` | \`<descriptive-name>.md\` with original URL + visual description |
| "starting a new project" | \`projects/<project>/\` | new folder + \`<project>.md\` entry point |
| "decided to go with X over Y" | \`projects/<project>/process/\` OR \`decisions/\` | \`YYYY-MM-DD-<topic>.md\` |
| "client said..." | \`clients/<client>/\` | dated note with verbatim feedback |
| "Figma link" / "asset link" | \`assets/\` or inline in project note | with description of what's inside |

### Context
- Visual work means screenshots and image refs. **Taproot stores text only** — when the user shares an image, the AI client (claude.ai, ChatGPT, etc.) describes it via vision; Taproot saves the description.
- Inspiration files compound over years. Tag them liberally for searchability (\`#color-palette\`, \`#typography\`, \`#layout\`, \`#brand-voice\`).
- When user asks "what was I thinking on X project," pull from \`projects/<project>/process/\` first.
- Process notes are valuable to future-you — log iterations, not just final calls.
- Client feedback lives verbatim. Don't paraphrase the client's words — capture them as-stated, then add your interpretation in a separate section.`,

  salesperson: `## Salesperson

You manage a pipeline. Notes serve account intelligence, deal progression, and the unglamorous follow-up discipline that compounds.

### Folders (added on top of the default skeleton)
- \`accounts/<company>/\` — one folder per account. \`<company>.md\` entry point with contacts, history, deal stage, blockers.
- \`accounts/<company>/calls/\` — call notes for that account, dated.
- \`deals/<deal>/\` — deals that span multiple accounts or have specific kickoff/close documentation.
- \`playbooks/\` — discovery questions, objection handling, demo scripts.
- \`competitive/<competitor>/\` — battlecards, win/loss notes, positioning angles.

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "had a call with X" / "demo with Y" | \`accounts/<company>/calls/\` | \`YYYY-MM-DD-<topic>.md\` |
| "save this account" / "researching X company" | \`accounts/<company>/\` | new folder + \`<company>.md\` entry |
| "follow up with X next week" | tag note \`#followup-<YYYY-MM-DD>\` | reminder logic comes Stage 4 |
| "objection from X" / "they pushed back on Y" | \`playbooks/objections/\` | one file per objection theme |
| "lost a deal" / "won a deal" | \`deals/<deal>/\` + \`deals/<deal>/postmortem.md\` | with reason |
| "competitor said" / "lost to X" | \`competitive/<competitor>/\` | dated note with context |

### Context
- Per-account history compounds. Always offer to add new notes to existing \`accounts/<company>/<company>.md\` rather than creating duplicate entries.
- Call notes structure: attendees, agenda, key quotes (verbatim, in quotes), action items, next steps.
- Pipeline state lives in CRM, not here. Notes are the qualitative layer — context, sentiment, internal politics, what was said off-script.
- When user asks "what do I know about X," pull from \`accounts/<company>/\`, recent \`calls/\`, and \`competitive/\` if relevant.
- Follow-ups: tag \`#followup-<YYYY-MM-DD>\` until Stage 4 reminder worker ships, then those become real reminders.`,

  student: `## Student

You're in a degree program. Notes serve coursework, exam prep, and the long-term accumulation of a learned discipline.

### Folders (added on top of the default skeleton)
- \`courses/<semester>/<course-code>/\` — one folder per course per semester (e.g., \`courses/2026-spring/cs-475/\`). Each has \`<course-code>.md\` entry point with syllabus, professor, grading scheme.
- \`courses/<semester>/<course>/lectures/\` — lecture notes by date.
- \`assignments/\` (or per-course) — submission tracker + working files.
- \`exams/\` — study guides, practice problems, post-exam reflections.
- \`papers/<paper-slug>/\` — your written papers (drafts, finals, citations).
- \`concepts/\` — atomic notes on individual concepts. A personal glossary that survives semesters.

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "lecture today" / "today's class" | \`courses/<semester>/<course>/lectures/\` | \`YYYY-MM-DD-<topic>.md\` |
| "homework for X" / "assignment due" | \`courses/.../assignments/\` | \`<course-code>-hw-<n>.md\` |
| "studying for X exam" | \`courses/.../exams/\` | \`<course-code>-<exam-name>.md\` |
| "started a paper on X" | \`papers/<paper-slug>/\` | folder with \`outline.md\`, \`draft.md\`, \`references.md\` |
| "this concept means X" / "definition of Y" | \`concepts/\` | \`<concept-slug>.md\` (lowercase, no spaces) |
| Citation for academic work | inline + \`references/\` | full citation frontmatter |

### Citation conventions
Academic citations include \`author\`, \`title\`, \`journal\` or \`book\`, \`year\`, \`pages\`, \`doi\` or \`url\` in frontmatter. Match your school's citation style (APA / MLA / Chicago) for in-line citations in papers.

### Context
- Atomic concept notes compound across semesters. When user mentions a term they've seen before, search \`concepts/\` and link.
- Lecture notes benefit from a 24-hour-after revision pass. When user says "let me review yesterday's notes," surface them and offer to clean up.
- Papers in progress get the writer-researcher draft workflow if that trait is also picked.
- Exam prep: pull all relevant \`lectures/\`, \`concepts/\`, and \`assignments/\` for the course.
- Course entry points (\`<course-code>.md\`) should stay current — syllabus changes, grading curve updates, prof office hour shifts. Offer to update when user mentions any of those.`,

  "life-os": `## Life-OS

You're using Taproot for personal organization — journaling, goals, reading, relationships, reflections. The vault is your second brain in the original sense.

### Folders (added on top of the default skeleton)
- \`journal/\` — daily entries. \`journal/YYYY-MM-DD.md\`. Optional weekly + monthly retrospectives in \`journal/weekly/\` and \`journal/monthly/\`.
- \`goals/\` — annual, quarterly, weekly goal-setting notes.
- \`habits/\` — habit tracker entries, streak logs, system design.
- \`books/\` — one file per book. Notes, highlights, takeaways, rating.
- \`people/<name>/\` — one folder per important person (family, friends, mentors). Conversations, gifts, anniversaries, what matters to them.
- \`reflections/\` — long-form thinking-out-loud notes. End-of-year reviews, life pivots, decision frames.

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "journal entry" / "today I..." | \`journal/\` | \`YYYY-MM-DD.md\` (today) |
| "weekly review" / "looking back at this week" | \`journal/weekly/\` | \`YYYY-Wnn.md\` |
| "set a goal" / "I want to X by Y" | \`goals/\` | \`YYYY-<scope>.md\` (annual, q1, etc.) |
| "habit X" / "tracking X" | \`habits/\` | \`<habit-name>.md\` |
| "finished a book" / "reading X" | \`books/\` | \`<title-slug>.md\` with \`author\`, \`started\`, \`finished\`, \`rating\` frontmatter |
| "conversation with X" / "X told me" | \`people/<name>/\` | dated note |
| "thinking about X" / "wrestling with Y" | \`reflections/\` | \`YYYY-MM-DD-<topic>.md\` |

### Context
- Daily journal entries are the most-touched folder. When user says "what did I do yesterday/last week/last month," pull from \`journal/\`.
- People notes are private and high-trust. Don't surface them unprompted in research-style queries — only when user asks about that person directly.
- Goals lapse. If a goal note is older than 90 days and hasn't been touched, gently ask if it's still active when user mentions related work.
- Reflections compound. End-of-year reviews benefit from pulling all \`reflections/\` from the year + key \`journal/\` entries.
- Books read shape thinking. When user asks "what was that book that talked about X," search \`books/\`.
- Privacy: this folder set is more sensitive than work content. Be conservative about surfacing people/journal/reflections in chat unless explicitly asked.`,

  "professional-services": `## Professional Services

You run a service business — consulting, agency, freelance, advisory. Notes serve clients, projects, deliverables, and the operational discipline of a solo or small team.

### Folders (added on top of the default skeleton)
- \`clients/<client>/\` — one folder per client. \`<client>.md\` entry point with contacts, scope, contract dates, billing terms.
- \`clients/<client>/calls/\` — client meeting notes, dated.
- \`projects/<project>/\` — one folder per active engagement. Linked to \`clients/<client>/\` via wikilink.
- \`projects/<project>/deliverables/\` — drafts and finals of what you ship.
- \`proposals/\` — one file per proposal. Wins move to \`clients/<client>/\` once signed.
- \`contracts/\` — links to signed PDFs (Taproot stores text refs; PDFs live elsewhere) + plaintext term summaries.
- \`templates/\` — proposal templates, SOWs, status reports, intake forms.
- \`time/\` — time tracking notes if not in a separate tool.

### Filing rules
| User says | File in | Naming |
|---|---|---|
| "new client" / "signed X" | \`clients/<client>/\` | new folder + \`<client>.md\` entry |
| "starting a project for X" | \`projects/<project>/\` | folder linked to \`clients/<client>/\` |
| "draft proposal for X" | \`proposals/\` | \`<client-or-project>-proposal-vN.md\` |
| "client meeting" / "call with X" | \`clients/<client>/calls/\` | \`YYYY-MM-DD-<topic>.md\` |
| "delivered X" / "shipped Y" | \`projects/<project>/deliverables/\` | dated note with what was sent |
| "template for X" | \`templates/\` | reusable structure |

### Context
- Each \`clients/<client>/<client>.md\` entry point should stay current. Contacts, scope changes, status, blockers — when something changes, offer to update it.
- Project notes link back to client notes via \`[[clients/<client>/<client>]]\` so navigation works in both directions.
- Proposals are the front of the funnel; track them even when they don't close — patterns emerge.
- Templates compound. Every proposal you send is a chance to refine the template.
- When user asks "what's the status of my work for X," pull \`clients/<client>/<client>.md\` + recent \`projects/<project>/\` notes.
- Scope creep is the killer. When user mentions "the client also wants...", offer to log it in the project note + flag whether it's in or out of scope.`,
};

const COMMON_PREAMBLE = `## What This Vault Is

This is your second brain. You (the AI) read it, write to it, and keep it organized. The user directs strategy; you execute.

- All content is markdown — portable, future-proof, human-readable.
- Obsidian renders these files — use \`[[wikilinks]]\` to connect ideas.
- Every interaction should leave the vault better than you found it.

## Read FIRST (before every answer)

**BLOCKING:** Before answering questions about the user's projects, past decisions, or anything that may already live in the vault — search the vault first. It has context that general knowledge will miss.

1. Read \`index.md\` to see what's catalogued.
2. Search relevant folders for prior notes on the topic.
3. Read the most relevant pages before responding.
4. Cite sources with \`[[wikilinks]]\` when drawing from vault content.

This applies to every conversation. The vault is the source of truth.

## Default folder skeleton

Every vault ships with these folders. Trait sections below add more on top.

- \`daily/\` — session logs, daily activity.
- \`decisions/\` — decisions with reasoning. Universal — everyone makes choices worth logging.
- \`projects/\` — active work, one folder per project.
- \`research/\` — deep dives, evaluations, market research.
- \`references/\` — saved articles, sources, external info.
- \`ideas/\` — half-baked thoughts, future work.
- \`inbox/\` — fallback for stuff that doesn't have a home yet. File here when no other folder fits.

## Filing decision tree

When the user asks you to save something, decide the path in this order:

1. **Explicit user direction wins.** If the user says "save this to \`<folder>\`," use that path. Create the folder if it doesn't exist.
2. **CLAUDE.md filing rule match.** If content matches a rule in the trait sections below, file there. **You can create new subfolders within the matched top-level folder** (e.g., \`research/ai-tools/\` if researching AI tools and no subfolder exists yet). Announce it: "Saved to \`research/ai-tools/foo.md\`. Created new folder \`research/ai-tools/\`."
3. **Top-level theme match, no subfolder.** If content fits a top-level theme but no specific subfolder exists, create a sensibly-named new subfolder under the best-fit parent. Same announcement pattern.
4. **No clear home.** File to \`inbox/\` with frontmatter \`suggested-folder: <best-guess>\`. Tell the user: "Saved to \`inbox/foo.md\`. Best guess: \`research/something-or-other\`. Move it when you're sure."
5. **NEVER create a new TOP-LEVEL folder silently.** If you think the vault needs a new top-level category (e.g., \`interviews/\` or \`legal/\`), ASK the user first: "I'd suggest a new top-level folder \`interviews/\` for this kind of note. Create it?" New top-level folders should be deliberate, not accidental — vault sprawl is a real failure mode.

**Why:** without the inbox fallback + the explicit "no top-level silent creation" rule, vaults drift. Three different sessions create \`articles/\`, \`saved/\`, and \`bookmarks/\` for the same kind of content. The inbox absorbs the indecision; the user sorts it later.

## Master index

\`index.md\` lives at vault root. It's a catalog of every note with a one-line summary.

- **Read \`index.md\` first** when searching the vault — faster than globbing folders, and surfaces notes whose filenames don't obviously match.
- **Update \`index.md\` after every write.** When you create a new note OR significantly update an existing one, add/revise its entry. Format: \`- [[<wikilink>]] — <one-line summary>\`, under 100 characters. File the entry under the matching \`## <Folder>\` section header. If the file lives in a folder that doesn't have a section yet (a new top-level the user explicitly asked you to create), add a new \`## <Folder>\` header — don't append loose entries to the bottom.
- **Don't update the index for trivial edits** (typo fixes, formatting, single-line additions). Use judgment: if the note's purpose or scope changed, revise the index line; otherwise leave it.
- **Keep it scannable.** No frontmatter on \`index.md\` itself. No prose paragraphs — sectioned bullet lists only. No emoji in entries.

## Marking dead / superseded content

When a topic is abandoned, a strategy changes, or information becomes obsolete:

1. Add \`status: archived\` (or \`status: killed\`) to the frontmatter.
2. Add a bold line at the top: **⚠️ ARCHIVED (YYYY-MM-DD) — [reason].**
3. Update \`index.md\` — append "(ARCHIVED)" to the one-line summary.

Never delete dead content — it has historical value. Just mark it clearly so searches don't surface it as active.`;

const UNIVERSAL_TAIL = `## Conventions (universal)

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
\`\`\`

## Writing style

- Direct, no fluff.
- Bullet points over paragraphs.
- Include the *why* behind decisions, not just the *what*.
- Link related notes with \`[[wikilinks]]\`.

## Compounding knowledge loop

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
- **Decisions override research.** If a \`decisions/\` note says "we chose X" and a \`research/\` note still argues for Y, the decision stands.

## Self-updating instructions

If the user expresses a preference about how they like work done — file naming, writing style, what to log, what not to log, folder organization — **update this CLAUDE.md file to reflect it.** These instructions should evolve to match how the user actually works.`;

/**
 * Compose a personalized CLAUDE.md from the user's persona traits + freetext.
 *
 * - Empty `traits` is allowed — emits preamble + freetext (if present) + tail.
 *   Useful for users who don't fit any of the supplied traits.
 * - Unknown traits are silently dropped (validated upstream by /api/persona,
 *   so this is just defensive). Caller should pre-validate via {@link isTraitId}.
 * - Trait order is preserved in the rendered output.
 * - Duplicate traits are dropped (only the first occurrence renders).
 */
export function composePersonaClaudeMd(opts: {
  traits: string[];
  personaFreetext?: string;
}): string {
  const today = new Date().toISOString().split("T")[0];

  const seen = new Set<string>();
  const orderedTraits: TraitId[] = [];
  for (const t of opts.traits) {
    if (!isTraitId(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    orderedTraits.push(t);
  }

  const parts: string[] = [];
  parts.push(`# CLAUDE.md\n\n> Created ${today} | Taproot brain`);
  parts.push(COMMON_PREAMBLE);

  const freetext = opts.personaFreetext?.trim();
  if (freetext) {
    parts.push(
      `## User's stated context\n\n> ${freetext.replace(/\n/g, "\n> ")}`,
    );
  }

  for (const t of orderedTraits) {
    parts.push(TRAIT_SECTIONS[t]);
  }

  parts.push(UNIVERSAL_TAIL);

  return parts.join("\n\n") + "\n";
}
