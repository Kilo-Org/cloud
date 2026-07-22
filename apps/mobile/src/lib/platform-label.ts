// kilocode_change - new file
// K1/C3a: single source of truth for mapping a backend platform string
// (`created_on_platform` / the live heartbeat's per-session `platform`
// field) to a pretty uppercase label. Previously duplicated identically in
// `session-row.tsx` and `agent-sessions-section.tsx`; centralizing here
// means the `kilo remote` label fix ("CLI" instead of a hardcoded "CLOUD
// AGENT") can never drift between the two sites.
export function platformLabel(platform: string): string {
  switch (platform) {
    case 'cloud-agent':
    case 'cloud-agent-web': {
      return 'CLOUD AGENT';
    }
    case 'vscode':
    case 'agent-manager': {
      return 'VSCODE';
    }
    case 'slack': {
      return 'SLACK';
    }
    case 'cli': {
      return 'CLI';
    }
    default: {
      return platform.toUpperCase();
    }
  }
}
