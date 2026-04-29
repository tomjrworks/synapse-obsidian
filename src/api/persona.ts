import { Router } from "express";
import {
  composePersonaClaudeMd,
  isTraitId,
  TRAIT_INDEX_HEADERS,
} from "../tools/persona-claudemd.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

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
    if (!isTraitId(t)) continue;
    for (const header of TRAIT_INDEX_HEADERS[t]) {
      if (seen.has(header)) continue;
      seen.add(header);
      sections.push(`## ${header}\n\n`);
    }
  }

  return INDEX_HEADER_COMMENT + "\n" + sections.join("");
}

export function personaRouter(): Router {
  const router = Router();

  router.get(
    "/persona/claudemd",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;

      const persona = membership.settings.persona ?? {};
      const traits: string[] = Array.isArray(persona.traits)
        ? persona.traits
        : [];
      const freetext =
        typeof persona.freetext === "string" ? persona.freetext.trim() : "";

      // Either at least one trait OR non-empty freetext is required —
      // empty-traits + non-empty freetext still composes a valid CLAUDE.md
      // (preamble + user context + tail) per the templates spec.
      if (traits.length === 0 && !freetext) {
        res.status(400).json({ error: "persona_not_set" });
        return;
      }

      const claudeMd = composePersonaClaudeMd({
        traits,
        personaFreetext: freetext || undefined,
      });

      res.type("text/markdown").send(claudeMd);
    }),
  );

  router.get(
    "/persona/index-stub",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;

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
