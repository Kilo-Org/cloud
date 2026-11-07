import { i18n } from '@/i18n';

// `platformLabel` maps a backend platform string (`created_on_platform` or
// the heartbeat `platform` field) to the uppercase origin label. This file is
// the only implementation. An absent origin — no value, the empty string, or
// the backend's `'unknown'` sentinel — gets the neutral origin label, never a
// status word: a stored row renders this label in its eyebrow, where "LIVE"
// read as the row's own state. A live row names its live state itself
// (`remoteAgentLabel` in session-list-helpers.ts) before it gets here.
export function platformLabel(platform: string | null | undefined): string {
  if (isUnknownOrigin(platform)) {
    return i18n.t('common.unknown');
  }
  // Flow-sensitive narrowing skips null through the predicate, but the switch's
  // `default` still reads `platform`; assert the recorded origin here once.
  return platformLabelRecorded(platform as string);
}

function platformLabelRecorded(platform: string): string {
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
 * Whether a created-on-origin value is unrecorded: no value, the empty string,
 * or the backend's `'unknown'` sentinel. The one predicate behind the neutral
 * origin label and its tint, so the code never compares rendered label text
 * to pick a colour, and a repository named like the label cannot read as one.
 */
export function isUnknownOrigin(platform: string | null | undefined): boolean {
  return !platform || platform === 'unknown';
}

/**
 * Which tint key a live row's eyebrow carries for an origin: `live` when the
 * live label stands for an unrecorded origin, `platform` when the row names
 * the kind of agent it ran on. The one predicate behind the live label and
 * its tint, so a translated word can never drift to another token. Lives here
 * because the platform string is this file's input; `remoteAgentLabel`
 * renders the row copy from it.
 *
 * A repository name never reaches this predicate: the caller names the
 * repository instead of the origin.
 */
export function remoteAgentState(platform: string | null | undefined): 'live' | 'platform' {
  return isUnknownOrigin(platform) ? 'live' : 'platform';
}
