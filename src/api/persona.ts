import { Router } from "express";
import { composePersonaClaudeMd } from "../tools/persona-claudemd.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { getBackend } from "../utils/backend-cache.js";
import { scanFolders } from "../utils/folder-scan.js";

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

function buildIndexStub(): string {
  const sections = UNIVERSAL_SECTIONS.map((title) => `## ${title}\n\n`).join(
    "",
  );
  return INDEX_HEADER_COMMENT + "\n" + sections;
}

export function personaRouter(): Router {
  const router = Router();

  router.get(
    "/persona/claudemd",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const workspaceId = membership.workspaceId;

      const folderScan = await (async () => {
        try {
          const backend = await getBackend(workspaceId);
          return await scanFolders(backend);
        } catch {
          return [];
        }
      })();

      const claudeMd = composePersonaClaudeMd({ folderScan });
      res.type("text/markdown").send(claudeMd);
    }),
  );

  router.get(
    "/persona/index-stub",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (_req, res) => {
      const stub = buildIndexStub();
      res.type("text/markdown").send(stub);
    }),
  );

  return router;
}
