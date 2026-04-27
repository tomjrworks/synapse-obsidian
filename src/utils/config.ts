import type { StorageBackend } from "./storage.js";

const CONFIG_DIR = ".taproot";
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const LEGACY_CONFIG_PATH = ".synapse/config.json";

export interface SynapseConfig {
  mode: "existing" | "structured" | "kb" | "custom";
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
    sourcesFolder: "sources",
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
 * Load the Taproot config from .taproot/config.json in the vault root.
 * Falls back to the legacy .synapse/config.json for vaults that haven't
 * been re-saved since the Stage 1 rename. Returns null if no config exists.
 */
export async function loadConfig(
  backend: StorageBackend,
): Promise<SynapseConfig | null> {
  try {
    if (await backend.exists(CONFIG_PATH)) {
      const raw = await backend.readFile(CONFIG_PATH);
      return JSON.parse(raw) as SynapseConfig;
    }
    if (await backend.exists(LEGACY_CONFIG_PATH)) {
      const raw = await backend.readFile(LEGACY_CONFIG_PATH);
      return JSON.parse(raw) as SynapseConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save the Taproot config to .taproot/config.json in the vault root.
 * Existing .synapse/config.json is left in place but stops being read once
 * the new file exists; users can delete it manually.
 */
export async function saveConfig(
  backend: StorageBackend,
  config: SynapseConfig,
): Promise<void> {
  if (!(await backend.exists(CONFIG_DIR))) {
    await backend.mkdir(CONFIG_DIR);
  }
  const json = JSON.stringify(config, null, 2);
  await backend.writeFile(CONFIG_PATH, json);
}
