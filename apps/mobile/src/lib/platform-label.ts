import { i18n } from '@/i18n';

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
      // Locale-aware: Turkish `i` uppercases to `İ`, not `I`.
      return platform.toLocaleUpperCase(i18n.language);
    }
  }
}
