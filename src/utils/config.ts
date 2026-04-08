import type { StorageBackend } from "./storage.js";

const CONFIG_PATH = ".synapse/config.json";

export interface SynapseConfig {
  mode: "existing" | "kb" | "custom";
  /** Where raw/source articles are saved */
  sourcesFolder: string;
  /** Where compiled/processed content goes (null if using existing structure) */
  wikiFolder: string | null;
  /** Where query outputs/answers go */
  outputsFolder: string;
  /** Naming conventions */
  fileNaming: "kebab-case" | "title-case" | "as-is";
  /** Whether to use YAML frontmatter */
  useFrontmatter: boolean;
  /** Whether to use [[wikilinks]] */
  useWikilinks: boolean;
  /** The CLAUDE.md path (if exists) */
  schemaPath: string | null;
  /** Topic (for KB mode) */
  topic: string | null;
  /** Vault purpose — shapes how Claude uses the tools */
  purpose:
    | "knowledge-base"
    | "business"
    | "academic"
    | "life-os"
    | "custom"
    | null;
  /** Custom purpose description (when purpose is "custom") */
  purposeDescription: string | null;
  /** Timestamp */
  configuredAt: string;
}

export function getDefaultConfig(): SynapseConfig {
  return {
    mode: "existing",
    sourcesFolder: "raw/articles",
    wikiFolder: null,
    outputsFolder: "outputs",
    fileNaming: "kebab-case",
    useFrontmatter: true,
    useWikilinks: true,
    schemaPath: null,
    topic: null,
    purpose: null,
    purposeDescription: null,
    configuredAt: "",
  };
}

/**
 * Load the Synapse config from .synapse/config.json in the vault root.
 * Returns null if no config exists yet.
 */
export async function loadConfig(
  backend: StorageBackend,
): Promise<SynapseConfig | null> {
  try {
    if (!(await backend.exists(CONFIG_PATH))) {
      return null;
    }
    const raw = await backend.readFile(CONFIG_PATH);
    const parsed = JSON.parse(raw) as SynapseConfig;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save the Synapse config to .synapse/config.json in the vault root.
 */
export async function saveConfig(
  backend: StorageBackend,
  config: SynapseConfig,
): Promise<void> {
  // Ensure .synapse directory exists
  if (!(await backend.exists(".synapse"))) {
    await backend.mkdir(".synapse");
  }
  const json = JSON.stringify(config, null, 2);
  await backend.writeFile(CONFIG_PATH, json);
}
