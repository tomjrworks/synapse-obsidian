// ─────────────────────────────────────────────────────────────────────────
// FROZEN fixture corpus for the Pass 3 retrieval A/B harness (EVALS §3b).
//
// Must reproduce the IS-7011 collision: V1 scores `basename.includes("is")` so
// the daily handoffs whose filenames contain the SUBSTRING "is"/"it"/"mcp"
// (decisions, analysis, revised, advisory, …) manufacture the junk +10 hits
// that bury real course content. A fixture with only the gold file would make
// V1 look artificially good. Gold files + ~25 noise files → ~40 total.
//
// Frozen by git (committed). Folder names are kebab (no spaces) so the harness
// path-parsing stays simple; the gold-set accepts these stand-ins for the real
// vault's "school/AI Governance/" etc.
//
// Bodies deliberately do NOT embed other files' .md paths (the harness parses
// result paths from tool output by path presence).
// ─────────────────────────────────────────────────────────────────────────

export const CORPUS: Record<string, string> = {
  // ── Managed index (served verbatim by garden_index; a priority-hint source) ──
  "index.md": [
    "---",
    "TAPROOT-MANAGED:index: true",
    "---",
    "# Vault index",
    "",
    "## decisions/",
    "- [[2026-05-12-taproot-pricing-model]] — why we killed freemium and the pricing tiers",
    "- [[2026-05-28-mcp-7-pass-roadmap]] — the 7-pass MCP retrieval rebuild plan",
    "- [[2026-05-28-mcp-tooling-audit-handoff]] — MCP tool-call surface audit",
    "## projects/",
    "- [[taproot]] — Taproot project entry point",
    "- [[outbound-dm-copy]] — cold DM copy and scripts for Taproot outreach",
    "## school/",
    "- [[module-1-it-competitive-advantage]] — IS 7011 module 1",
  ].join("\n"),

  // ── Category A gold: IS 7011 course notes (school/is-7011-it-management/**) ──
  "school/is-7011-it-management/module-1-it-competitive-advantage.md": [
    "---",
    "title: IS 7011 Module 1 — IT and Competitive Advantage",
    "tags: [school, information-systems, it-management]",
    "type: course-note",
    "summary: How information systems create sustained competitive advantage",
    "---",
    "# IT and competitive advantage",
    "",
    "This module of IS 7011 covers how information technology produces",
    "competitive advantage. The syllabus frames IT as a strategic resource.",
    "Key frameworks: value chain, resource based view, IT capability.",
  ].join("\n"),
  "school/is-7011-it-management/module-2-data-governance.md": [
    "---",
    "title: IS 7011 Module 2 — Data Governance",
    "tags: [school, information-systems, governance]",
    "type: course-note",
    "summary: Data governance and stewardship in the IS 7011 course",
    "---",
    "# Data governance",
    "",
    "Module 2 of IS 7011 examines data governance, stewardship, and the",
    "management of information assets across the enterprise.",
  ].join("\n"),

  // ── A1 anti-gold (acceptable secondary): a log matched on the is7011 token ──
  "daily/2026-05/2026-05-17-is7011-case-writeup-1-handoff.md": [
    "---",
    "title: IS7011 case writeup 1 — handoff",
    "type: handoff",
    "---",
    "# Handoff",
    "",
    "Logged progress on the case writeup for the course. Next steps recorded.",
  ].join("\n"),

  // ── A2 anti-gold: daily handoffs matched ONLY on the substring "is"/"it" ──
  "daily/2026-05/2026-05-10-pricing-decisions.md":
    "---\ntype: handoff\n---\n# Pricing decisions\n\nLogged the pricing decisions we made today.",
  "daily/2026-05/2026-05-11-competitor-analysis.md":
    "---\ntype: handoff\n---\n# Competitor analysis\n\nRan a competitor analysis sweep.",
  "daily/2026-05/2026-05-12-revised-roadmap.md":
    "---\ntype: handoff\n---\n# Revised roadmap\n\nRevised the roadmap after the planning call.",
  "daily/2026-05/2026-05-14-advisory-notes.md":
    "---\ntype: handoff\n---\n# Advisory notes\n\nMisc advisory notes from the mentor session.",
  "daily/2026-05/2026-05-19-logistics-checklist.md":
    "---\ntype: handoff\n---\n# Logistics checklist\n\nLogistics checklist for the launch.",

  // ── Category B1 gold: AI folders ──
  "school/ai-governance/ai-risk-frameworks.md": [
    "---",
    "title: AI risk frameworks",
    "tags: [school, ai, governance]",
    "type: course-note",
    "summary: NIST and EU AI Act risk frameworks",
    "---",
    "# AI risk frameworks",
    "",
    "Survey of AI governance risk frameworks for the AI governance course.",
  ].join("\n"),
  "school/ai-powered-bots/building-ai-agents.md": [
    "---",
    "title: Building AI agents",
    "tags: [school, ai, agents]",
    "type: course-note",
    "summary: Architecture of AI-powered bots and agents",
    "---",
    "# Building AI agents\n\nNotes on building AI powered bots and agent loops.",
  ].join("\n"),
  // B1 anti-gold: "ai" appears MID-WORD (main, await, again)
  "daily/2026-05/2026-05-15-main-loop-refactor.md":
    "---\ntype: handoff\n---\n# Main loop refactor\n\nRefactored the main loop scheduler.",
  "daily/2026-05/2026-05-16-await-queue-fix.md":
    "---\ntype: handoff\n---\n# Await queue fix\n\nFixed an await ordering bug in the queue.",
  "daily/2026-05/2026-05-18-again-retrospective.md":
    "---\ntype: handoff\n---\n# Again retrospective\n\nWent over the sprint again in retro.",

  // ── Category B2 gold: PR-numbered dailies (pr7/pr8/pr9) ──
  // pr7 doubles as C2 gold (body holds the stripe webhook ERROR story).
  "daily/2026-05/2026-05-21-pr7-stripe-webhook-shipped.md": [
    "---",
    "title: PR7 stripe webhook shipped",
    "type: handoff",
    "summary: Shipped the stripe webhook handler",
    "---",
    "# PR7 — stripe webhook shipped",
    "",
    "Shipped the stripe webhook endpoint. Spent the morning chasing signature",
    "verification errors — the raw body parser was the culprit. Webhook errors",
    "are now logged with the event id.",
  ].join("\n"),
  "daily/2026-05/2026-05-22-pr8-oauth-fix.md":
    "---\ntype: handoff\n---\n# PR8 oauth fix\n\nFixed the oauth token refresh in PR8.",
  "daily/2026-05/2026-05-23-pr9-telemetry-wrapper.md":
    "---\ntype: handoff\n---\n# PR9 telemetry wrapper\n\nLanded the telemetry wrapper in PR9.",
  // B2 anti-gold: "pr" as a substring (project, prune)
  "notes/prune-old-notes.md":
    "# Prune old notes\n\nA chore note about pruning stale notes.",

  // ── Category B3 gold: substantive MCP docs (roadmap doubles as G2 gold) ──
  "decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md": [
    "---",
    "title: MCP 7-pass retrieval roadmap",
    "tags: [taproot, mcp, retrieval]",
    "type: decision",
    "summary: The 7-pass plan to rebuild MCP retrieval with a kill switch",
    "---",
    "# MCP 7-pass roadmap",
    "",
    "The roadmap to rebuild MCP retrieval over seven passes, each gated behind",
    "a kill switch. Pass 3 is the retrieval scoring rebuild.",
  ].join("\n"),
  "decisions/taproot/2026-05-28-mcp-tooling-audit-handoff.md": [
    "---",
    "title: MCP tooling audit handoff",
    "tags: [taproot, mcp, audit]",
    "type: handoff",
    "summary: Audit of the MCP tool-call surface",
    "---",
    "# MCP tooling audit\n\nAudited the MCP tool-call surface and logged findings.",
  ].join("\n"),
  // B3 anti-gold: a daily mentioning mcp only in passing (no mcp in filename)
  "daily/2026-06/2026-06-02-standup.md":
    "---\ntype: handoff\n---\n# Standup\n\nTouched the mcp server briefly, mostly worked on billing.",

  // ── Category C1/C3/G3 gold: pricing model decision (body-resident) ──
  "decisions/2026-05-12-taproot-pricing-model.md": [
    "---",
    "title: Taproot pricing model",
    "tags: [taproot, pricing]",
    "type: decision",
    "summary: The Taproot pricing model and why freemium was killed",
    "---",
    "# Taproot pricing model",
    "",
    "We killed freemium because the free tier cannibalized conversion and the",
    "support load was unsustainable. The pricing model is now two paid tiers.",
    "Pricing is anchored on the value of the memory layer.",
  ].join("\n"),

  // ── Category E1 gold: cold DM scripts (lexical gap — copy/framework vs script)
  "projects/taproot/gtm/outbound-dm-copy.md": [
    "---",
    "title: Outbound DM copy",
    "tags: [taproot, gtm, outreach]",
    "type: playbook",
    "summary: Cold DM copy for Taproot founder outreach",
    "---",
    "# Outbound DM copy\n\nThe cold DM copy we send to founders for Taproot.",
  ].join("\n"),
  "projects/taproot/gtm/dm-framework-pain-to-pitch.md": [
    "---",
    "title: DM framework — pain to pitch",
    "tags: [taproot, gtm]",
    "type: playbook",
    "summary: The pain-to-pitch DM framework",
    "---",
    "# DM framework\n\nPain to pitch framework for Taproot cold DMs.",
  ].join("\n"),
  "projects/taproot/gtm/2026-05-13-dm-loom-script.md": [
    "---",
    "title: DM loom script",
    "tags: [taproot, gtm]",
    "type: script",
    "summary: Loom video script for DM follow-ups",
    "---",
    "# DM loom script\n\nThe loom script for Taproot DM follow-ups.",
  ].join("\n"),

  // ── Category D2 gold + project entry point ──
  "projects/taproot/taproot.md": [
    "---",
    "title: Taproot",
    "tags: [taproot]",
    "type: project",
    "summary: Taproot — the memory layer for your AI",
    "---",
    "# Taproot\n\nTaproot is the memory layer for AI. Project entry point.",
  ].join("\n"),

  // ── Category G1 gold: garden_find hang fix session (strong filename match) ──
  "daily/2026-06/2026-06-01-garden-find-hang-fix-session-a.md": [
    "---",
    "title: garden_find hang fix — session a",
    "type: handoff",
    "summary: Bounded the body scan to kill the garden_find hang",
    "---",
    "# garden_find hang fix\n\nBounded the body scan that caused the garden_find hang.",
  ].join("\n"),

  // ── Recent dailies for D1 (temporal "this week") ──
  "daily/2026-06/2026-06-03-pass-3-implement.md":
    "---\ntype: handoff\n---\n# Pass 3 implement\n\nStarted the Pass 3 retrieval implement.",
  "daily/2026-06/2026-06-02-pass-3-plan.md":
    "---\ntype: handoff\n---\n# Pass 3 plan\n\nWrote and audited the Pass 3 plan.",

  // ── Generic filler / noise (fills folders, adds non-matching corpus mass) ──
  "notes/grocery-list.md": "# Grocery list\n\nEggs, milk, coffee.",
  "notes/reading-queue.md": "# Reading queue\n\nBooks to read this quarter.",
  "notes/workout-log.md": "# Workout log\n\nLeg day notes.",
  "projects/coldcraft/coldcraft.md":
    "---\ntype: project\n---\n# ColdCraft\n\nCold email automation project.",
  "projects/glug/glug.md":
    "---\ntype: project\n---\n# Glug\n\nHydration app where the fish dies.",
  "daily/2026-05/2026-05-20-billing-webhook-notes.md":
    "---\ntype: handoff\n---\n# Billing webhook notes\n\nNotes on the billing webhook flow.",
  "daily/2026-05/2026-05-24-onboarding-polish.md":
    "---\ntype: handoff\n---\n# Onboarding polish\n\nPolished the onboarding copy.",
  "references/voice/toms-raw-voice.md":
    "# Tom's raw voice\n\nVoice reference doc.",
  "meetings/2026-05-25-mentor-call.md":
    "---\ntype: meeting\n---\n# Mentor call\n\nNotes from the mentor call.",
};
