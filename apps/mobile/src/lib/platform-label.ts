import { i18n } from '@/i18n';

// `platformLabel` maps a backend platform string (`created_on_platform` or
// the heartbeat `platform` field) to the uppercase origin label. This file is
// the only implementation. An absent origin — no value, the empty string, or
// the backend's `'unknown'` sentinel — gets the neutral origin label, never a
// status word: a stored row renders this label in its eyebrow, where "LIVE"
// read as the row's own state. A live row names its live state itself
// (`remoteAgentLabel` in session-list-helpers.ts) before it gets here.
export function platformLabel(platform: string | null | undefined): string {
  if (!platform || platform === 'unknown') {
    return i18n.t('common.unknown');
  }
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

/**
 * Which state word a live row's eyebrow carries for an origin: 'live' for an
 * unrecorded one, null for a real origin. The one predicate behind the live
 * label and its tint, so a translated word can never drift to another token
 * while an origin name keeps its own deterministic hash. Lives here because
 * the platform string is this file's input; `remoteAgentLabel` renders the
 * row copy from it.
 */
export function remoteAgentState(platform: string | null | undefined): 'live' | null {
  return !platform || platform === 'unknown' ? 'live' : null;
}
