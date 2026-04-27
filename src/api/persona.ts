import { Router } from "express";
import { generateClaudeMd } from "../tools/init.js";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { getMembershipForUser } from "./workspace.js";

// Trait → CLAUDE.md opts. T10 will refactor generateClaudeMd to take a
// multi-trait persona directly; for now the API uses the user's first
// trait if multiple are set, with this placeholder mapping.
const TRAIT_OPTS: Record<
  string,
  {
    topic: string;
    purpose: "knowledge-base" | "business" | "academic" | "life-os";
    section_title: string;
  }
> = {
  founder: {
    topic: "startup",
    purpose: "business",
    section_title: "Founder",
  },
  "writer-researcher": {
    topic: "research and writing",
    purpose: "knowledge-base",
    section_title: "Writing & Research",
  },
  "creator-designer": {
    topic: "creative work",
    purpose: "knowledge-base",
    section_title: "Creative Work",
  },
  salesperson: {
    topic: "sales pipeline",
    purpose: "business",
    section_title: "Sales Pipeline",
  },
  student: {
    topic: "coursework",
    purpose: "academic",
    section_title: "Coursework",
  },
  "life-os": {
    topic: "life",
    purpose: "life-os",
    section_title: "Life OS",
  },
  "professional-services": {
    topic: "client work",
    purpose: "business",
    section_title: "Client Work",
  },
};

const UNIVERSAL_SECTIONS = [
  "Decisions",
  "Projects",
  "Daily",
  "Research",
  "References",
  "Ideas",
  "Inbox",
];

const INDEX_HEADER_COMMENT = `<!--
  This file is the master index of your vault. Claude maintains it.
  When you save a note, Claude appends a one-line entry under the
  matching section. Don't worry about formatting; it'll keep itself tidy.
-->
`;

function buildIndexStub(traits: string[]): string {
  const seen = new Set<string>();
  const sections: string[] = [];

  for (const title of UNIVERSAL_SECTIONS) {
    if (seen.has(title)) continue;
    seen.add(title);
    sections.push(`## ${title}\n\n`);
  }

  for (const t of traits) {
    const opt = TRAIT_OPTS[t];
    if (!opt) continue;
    if (seen.has(opt.section_title)) continue;
    seen.add(opt.section_title);
    sections.push(`## ${opt.section_title}\n\n`);
  }

  return INDEX_HEADER_COMMENT + "\n" + sections.join("");
}

export function personaRouter(): Router {
  const router = Router();

  router.get(
    "/persona/claudemd",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const persona = membership.settings.persona ?? {};
      const traits: string[] = Array.isArray(persona.traits)
        ? persona.traits
        : [];
      if (traits.length === 0) {
        res.status(400).json({ error: "persona_not_set" });
        return;
      }

      // T10 will refactor generateClaudeMd to accept multi-trait directly.
      // For T2 we use the first trait; multi-trait composition is deferred.
      const primaryTrait = traits[0];
      const opt = TRAIT_OPTS[primaryTrait] ?? TRAIT_OPTS["life-os"];

      const claudeMd = generateClaudeMd({
        topic: opt.topic,
        purpose: opt.purpose,
        sourcesFolder: "sources",
        notesFolder: "notes",
        outputsFolder: "outputs",
        fileNaming: "kebab-case",
        useWikilinks: true,
        useFrontmatter: true,
      });

      res.type("text/markdown").send(claudeMd);
    }),
  );

  router.get(
    "/persona/index-stub",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const persona = membership.settings.persona ?? {};
      const traits: string[] = Array.isArray(persona.traits)
        ? persona.traits
        : [];

      const stub = buildIndexStub(traits);
      res.type("text/markdown").send(stub);
    }),
  );

  return router;
}
