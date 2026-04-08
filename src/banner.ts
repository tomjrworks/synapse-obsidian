const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const WHITE = "\x1b[97m";

export function printBanner(): void {
  console.error(`
${GREEN}    ╭───────────────────────────────╮
    │                               │
    │   ${WHITE}${BOLD}⚡ S Y N A P S E${RESET}${GREEN}             │
    │                               │
    │   ${DIM}the nervous system between${RESET}${GREEN}   │
    │   ${DIM}your AI and your notes${RESET}${GREEN}       │
    │                               │
    ╰───────────────────────────────╯${RESET}

  ${DIM}v${process.env.npm_package_version || "0.2.2"} · by Main Loop Systems${RESET}
  ${DIM}github.com/tomjrworks/synapse-obsidian${RESET}
`);
}
