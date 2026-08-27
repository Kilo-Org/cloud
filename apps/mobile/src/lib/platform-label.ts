// `platformLabel` maps a backend platform string (`created_on_platform` or
// the heartbeat `platform` field) to the uppercase label. This file is the
// only implementation.
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
