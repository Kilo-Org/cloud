/* eslint-disable max-lines -- cohesive unit-test suite for session-list-helpers pure functions */
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp, timeAgo } from '@/lib/utils';

import {
  activeSessionMetaTimestamp,
  canExitSessionFromList,
  composeActiveSessionSpokenMeta,
  composeActiveSessionVisibleMeta,
  composeSessionProvenanceSubtitle,
  expandPlatformFilter,
  formatGitUrlProject,
  formatMeta,
  formatScheduledWake,
  knownPlatformBucket,
  normalisePlatformSelection,
  PLATFORM_FILTERS,
  projectOptionKey,
  remoteAgentLabel,
  remoteMeta,
  remoteSessionEyebrowLabel,
  repoNameFromGitUrl,
  selectRemoteRowSpokenMeta,
  storedSessionEyebrowLabel,
} from './session-list-helpers';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

function makeActive(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

describe('composeSessionProvenanceSubtitle', () => {
  it('returns "branch · #N" when both branch and PR number exist', () => {
    expect(composeSessionProvenanceSubtitle({ branch: 'feature/x', prNumber: 42 })).toBe(
      'feature/x · #42'
    );
  });

  it('returns the branch when only branch is present', () => {
    expect(composeSessionProvenanceSubtitle({ branch: 'feature/x', prNumber: null })).toBe(
      'feature/x'
    );
    expect(composeSessionProvenanceSubtitle({ branch: 'feature/x', prNumber: undefined })).toBe(
      'feature/x'
    );
  });

  it('returns "#N" when only a PR number is present', () => {
    expect(composeSessionProvenanceSubtitle({ branch: null, prNumber: 7 })).toBe('#7');
    expect(composeSessionProvenanceSubtitle({ branch: undefined, prNumber: 7 })).toBe('#7');
  });

  it('returns null when neither branch nor PR number is present', () => {
    expect(composeSessionProvenanceSubtitle({ branch: null, prNumber: null })).toBeNull();
    expect(composeSessionProvenanceSubtitle({ branch: undefined, prNumber: undefined })).toBeNull();
    expect(composeSessionProvenanceSubtitle({ branch: '', prNumber: null })).toBeNull();
  });
});

describe('canExitSessionFromList', () => {
  it('returns true for a real CLI connection id', () => {
    expect(canExitSessionFromList(makeActive({ connectionId: 'c1' }))).toBe(true);
  });

  it('returns false for the cloud-agent sentinel connection id', () => {
    expect(canExitSessionFromList(makeActive({ connectionId: CLOUD_AGENT_CONNECTION_ID }))).toBe(
      false
    );
  });
});

describe('remoteAgentLabel', () => {
  it('returns the platform label for cli', () => {
    expect(remoteAgentLabel('cli')).toBe('CLI');
  });

  it('returns the platform label for cloud-agent-web', () => {
    expect(remoteAgentLabel('cloud-agent-web')).toBe('CLOUD AGENT');
  });

  it("returns 'LIVE' for undefined", () => {
    expect(remoteAgentLabel(undefined)).toBe('LIVE');
  });

  it("returns 'LIVE' for empty origin", () => {
    expect(remoteAgentLabel('')).toBe('LIVE');
  });

  it("returns 'LIVE' for unknown origin", () => {
    expect(remoteAgentLabel('unknown')).toBe('LIVE');
  });
});

describe('activeSessionMetaTimestamp', () => {
  it('prefers lastActivityAt over updatedAt', () => {
    expect(
      activeSessionMetaTimestamp({
        lastActivityAt: '2024-06-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      })
    ).toBe('2024-06-01T00:00:00.000Z');
  });

  it('falls back to updatedAt when lastActivityAt is absent', () => {
    expect(activeSessionMetaTimestamp({ updatedAt: '2024-01-01T00:00:00.000Z' })).toBe(
      '2024-01-01T00:00:00.000Z'
    );
  });

  it('returns undefined when neither timestamp is present', () => {
    expect(activeSessionMetaTimestamp({})).toBeUndefined();
  });
});

describe('remoteMeta', () => {
  it('returns the same relative-time string as formatMeta when updatedAt is present', () => {
    const updatedAt = '2024-01-01T00:00:00.000Z';
    expect(remoteMeta({ updatedAt })).toBe(formatMeta(updatedAt));
    expect(remoteMeta({ updatedAt })).toBe(timeAgo(parseTimestamp(updatedAt)).toUpperCase());
  });

  it('prefers lastActivityAt over updatedAt', () => {
    const lastActivityAt = '2024-06-01T00:00:00.000Z';
    const updatedAt = '2024-01-01T00:00:00.000Z';
    expect(remoteMeta({ lastActivityAt, updatedAt })).toBe(formatMeta(lastActivityAt));
  });

  it('formats the relative time from the caller\u2019s sampled clock', () => {
    // A memoized row cannot read the wall clock behind the memo, so the caller
    // passes the tick that re-rendered it. The same timestamp therefore reads
    // differently for two sampled clocks, and each matches `timeAgo`.
    const updatedAt = '2026-01-01T00:00:00.000Z';
    const base = parseTimestamp(updatedAt).getTime();
    const firstTick = base + 5 * 60_000;
    const laterTick = base + 20 * 60_000;

    expect(remoteMeta({ updatedAt }, firstTick)).toBe(
      timeAgo(parseTimestamp(updatedAt), undefined, firstTick).toUpperCase()
    );
    expect(remoteMeta({ updatedAt }, laterTick)).toBe(
      timeAgo(parseTimestamp(updatedAt), undefined, laterTick).toUpperCase()
    );
    expect(remoteMeta({ updatedAt }, laterTick)).not.toBe(remoteMeta({ updatedAt }, firstTick));
  });

  it('falls back to updatedAt when lastActivityAt is absent', () => {
    const updatedAt = '2024-01-01T00:00:00.000Z';
    expect(remoteMeta({ updatedAt })).toBe(formatMeta(updatedAt));
  });

  it('returns undefined when neither timestamp is present (never idle/busy/retry status words)', () => {
    // Former fallback uppercased session.status into the timestamp slot
    // (BUSY/IDLE/RETRY). Status is no longer a parameter; assert undefined
    // for each status that used to leak, plus a row with no status field.
    // Extra `status` fields stay on the object so a regression that re-reads
    // `.status` would still see them — remoteMeta must ignore them.
    const idleRow: { updatedAt?: string; lastActivityAt?: string; status?: string } = {
      status: 'idle',
    };
    const busyRow: { updatedAt?: string; lastActivityAt?: string; status?: string } = {
      status: 'busy',
    };
    const retryRow: { updatedAt?: string; lastActivityAt?: string; status?: string } = {
      status: 'retry',
    };
    const noStatusRow: { updatedAt?: string; lastActivityAt?: string } = {};
    expect(remoteMeta(idleRow)).toBeUndefined();
    expect(remoteMeta(busyRow)).toBeUndefined();
    expect(remoteMeta(retryRow)).toBeUndefined();
    expect(remoteMeta(noStatusRow)).toBeUndefined();
  });
});

describe('formatMeta (moved helper, regression guard)', () => {
  it('matches the original timeAgo + toUpperCase behavior', () => {
    expect(formatMeta('2024-01-01T00:00:00.000Z')).toBe(
      timeAgo(parseTimestamp('2024-01-01T00:00:00.000Z')).toUpperCase()
    );
  });
  it('omits a missing restored timestamp', () => {
    expect(formatMeta(null)).toBe('');
  });
});

describe('formatScheduledWake', () => {
  it('returns null when the timestamp does not parse', () => {
    expect(formatScheduledWake('not-a-timestamp')).toBeNull();
    expect(formatScheduledWake('')).toBeNull();
    expect(formatScheduledWake('2026-13-45T99:99:99Z')).toBeNull();
  });

  it('formats a valid ISO wake as a clock time with an hour and a minute', () => {
    const wake = formatScheduledWake('2026-09-24T09:00:00.000Z');
    expect(wake).not.toBeNull();
    expect(wake).toMatch(/\d/);
    expect(wake).toContain(':');
  });

  it('follows the active language (German uses a 24-hour clock)', async () => {
    await i18n.changeLanguage('de');
    const wake = formatScheduledWake('2026-09-24T09:00:00.000Z');
    expect(wake).not.toBeNull();
    expect(wake).not.toMatch(/AM|PM/);
  });
});

describe('expandPlatformFilter (regression guard for filter expansion)', () => {
  it('expands cloud-agent to include cloud-agent-web', () => {
    expect(expandPlatformFilter(['cloud-agent']).toSorted()).toEqual(
      ['cloud-agent', 'cloud-agent-web'].toSorted()
    );
  });

  it('expands extension to vscode and agent-manager', () => {
    expect(expandPlatformFilter(['extension']).toSorted()).toEqual(
      ['agent-manager', 'vscode'].toSorted()
    );
  });

  it('passes through unknown concrete values unchanged', () => {
    expect(expandPlatformFilter(['cli', 'other'])).toEqual(['cli', 'other']);
  });
});

describe('knownPlatformBucket (inverse of expandPlatformFilter)', () => {
  it('folds a platform variant into its filter bucket', () => {
    expect(knownPlatformBucket('cloud-agent-web')).toBe('cloud-agent');
    expect(knownPlatformBucket('vscode')).toBe('extension');
    expect(knownPlatformBucket('agent-manager')).toBe('extension');
  });

  it('returns the bucket itself for a bucket', () => {
    for (const bucket of PLATFORM_FILTERS) {
      expect(knownPlatformBucket(bucket)).toBe(bucket);
    }
  });

  it('returns null for an unknown platform', () => {
    expect(knownPlatformBucket('future-platform')).toBeNull();
    expect(knownPlatformBucket('')).toBeNull();
  });

  it('inverts expandPlatformFilter on every bucket', () => {
    for (const bucket of PLATFORM_FILTERS) {
      for (const platform of expandPlatformFilter([bucket])) {
        expect(knownPlatformBucket(platform)).toBe(bucket);
      }
    }
  });
});

describe('normalisePlatformSelection (persisted selection → sheet rows)', () => {
  it('collapses a stored variant into its bucket and keeps an unknown platform', () => {
    expect(normalisePlatformSelection(['cloud-agent-web', 'vscode'])).toEqual([
      'cloud-agent',
      'extension',
    ]);
    expect(normalisePlatformSelection(['jetbrains'])).toEqual(['jetbrains']);
  });

  it('dedupes a bucket saved alongside one of its variants', () => {
    expect(normalisePlatformSelection(['cloud-agent', 'cloud-agent-web'])).toEqual(['cloud-agent']);
    expect(normalisePlatformSelection(['extension', 'vscode', 'agent-manager'])).toEqual([
      'extension',
    ]);
  });

  it('expands to every raw platform of the checked row, so the history query covers the bucket', () => {
    expect(
      expandPlatformFilter(normalisePlatformSelection(['cloud-agent-web'])).toSorted()
    ).toEqual(['cloud-agent', 'cloud-agent-web'].toSorted());
  });
});

describe('formatGitUrlProject (percent-decoded segments)', () => {
  it('decodes an encoded CJK repository name in an https URL', () => {
    expect(formatGitUrlProject('https://github.com/org/%E5%B1%B1%E7%94%B0-API.git')).toBe(
      'org/山田-API'
    );
    expect(formatGitUrlProject('https://github.com/org/%E5%B1%B1%E7%94%B0-API')).toBe(
      'org/山田-API'
    );
  });

  it('decodes an encoded CJK repository name in an ssh URL', () => {
    expect(formatGitUrlProject('git@github.com:org/%E5%B1%B1%E7%94%B0-API.git')).toBe(
      'org/山田-API'
    );
    expect(formatGitUrlProject('git@github.com:org/%E5%B1%B1%E7%94%B0-API')).toBe('org/山田-API');
  });

  it('decodes every path segment, not only the repository name', () => {
    expect(
      formatGitUrlProject(
        'https://gitlab.com/%E7%A7%BB%E5%8A%A8%E7%AB%AF/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.git'
      )
    ).toBe('移动端/метаданные');
  });

  it('keeps the GitLab dash-separated project form while decoding', () => {
    expect(
      formatGitUrlProject('https://gitlab.com/group/%E7%A7%BB%E5%8A%A8%E7%AB%AF/-/tree/main')
    ).toBe('group/移动端');
  });

  it('keeps a malformed escape raw instead of throwing', () => {
    expect(formatGitUrlProject('https://github.com/org/%E5%B1%B1%ZZ-repo.git')).toBe(
      'org/%E5%B1%B1%ZZ-repo'
    );
    expect(formatGitUrlProject('https://github.com/org/100%-repo.git')).toBe('org/100%-repo');
    expect(formatGitUrlProject('git@github.com:org/100%-repo.git')).toBe('org/100%-repo');
  });

  it('decodes %25 to a single % and never decodes the value twice', () => {
    expect(formatGitUrlProject('https://github.com/org/50%2525-off.git')).toBe('org/50%25-off');
    expect(formatGitUrlProject('https://github.com/org/50%25-off.git')).toBe('org/50%-off');
  });

  it('leaves an already-decoded URL unchanged', () => {
    expect(formatGitUrlProject('https://github.com/org/山田-API.git')).toBe('org/山田-API');
    expect(formatGitUrlProject('git@github.com:org/метаданные.git')).toBe('org/метаданные');
  });
});

describe('projectOptionKey (visible-label identity)', () => {
  it('folds https, ssh, and a .git suffix into one key', () => {
    const key = projectOptionKey('https://github.com/org/repo.git');
    expect(key).toBe('org/repo');
    expect(projectOptionKey('https://github.com/org/repo')).toBe(key);
    expect(projectOptionKey('git@github.com:org/repo.git')).toBe(key);
    expect(projectOptionKey('git@github.com:org/repo')).toBe(key);
  });

  it('trims and lowercases the formatted label', () => {
    expect(projectOptionKey('https://github.com/Kilo-Org/KiloCode.git')).toBe('kilo-org/kilocode');
  });

  it('folds an encoded URL and the decoded repository name into one key', () => {
    const encoded = 'https://github.com/org/%E5%B1%B1%E7%94%B0-API.git';
    expect(projectOptionKey(encoded)).toBe(projectOptionKey('git@github.com:org/山田-API.git'));
    expect(projectOptionKey(encoded)).toBe('org/山田-api');
  });
});

describe('repoNameFromGitUrl', () => {
  it('returns null for null', () => {
    expect(repoNameFromGitUrl(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(repoNameFromGitUrl(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(repoNameFromGitUrl('')).toBeNull();
  });

  it('returns the last path segment for an SSH URL with .git suffix', () => {
    expect(repoNameFromGitUrl('git@github.com:org/my-repo.git')).toBe('my-repo');
  });

  it('returns the last path segment for an SSH URL without .git suffix', () => {
    expect(repoNameFromGitUrl('git@github.com:org/my-repo')).toBe('my-repo');
  });

  it('returns the last path segment for an https URL with .git suffix', () => {
    expect(repoNameFromGitUrl('https://github.com/org/my-repo.git')).toBe('my-repo');
  });

  it('returns the last path segment for an https URL without .git suffix', () => {
    expect(repoNameFromGitUrl('https://github.com/org/my-repo')).toBe('my-repo');
  });

  it('handles a nested group/project path (GitLab style) by returning the last segment', () => {
    // formatGitUrlProject strips the dash-prefixed project segment when there
    // are >=2 leading parts, so the last segment is the repo name.
    expect(repoNameFromGitUrl('https://gitlab.com/group/sub/my-repo.git')).toBe('my-repo');
  });

  it('returns the decoded repository name for a percent-encoded git URL', () => {
    expect(repoNameFromGitUrl('https://github.com/org/%E5%B1%B1%E7%94%B0-API.git')).toBe(
      '山田-API'
    );
    expect(
      repoNameFromGitUrl(
        'git@github.com:org/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.git'
      )
    ).toBe('метаданные');
  });
});

describe('storedSessionEyebrowLabel (canonical eyebrow — repo-name-first)', () => {
  it('returns the uppercased repo name when git_url is present (SSH)', () => {
    expect(
      storedSessionEyebrowLabel({
        git_url: 'git@github.com:org/my-repo.git',
        created_on_platform: 'cli',
      })
    ).toBe('MY-REPO');
  });

  it('returns the uppercased repo name when git_url is present (https)', () => {
    expect(
      storedSessionEyebrowLabel({
        git_url: 'https://github.com/org/my-repo.git',
        created_on_platform: 'cloud-agent',
      })
    ).toBe('MY-REPO');
  });

  it('falls back to the platform label when git_url is null', () => {
    expect(storedSessionEyebrowLabel({ git_url: null, created_on_platform: 'cli' })).toBe('CLI');
  });

  it('falls back to the platform label when git_url is the empty string', () => {
    expect(storedSessionEyebrowLabel({ git_url: '', created_on_platform: 'cloud-agent' })).toBe(
      'CLOUD AGENT'
    );
  });

  it('shows the decoded repository name for a percent-encoded git_url', () => {
    expect(
      storedSessionEyebrowLabel({
        git_url:
          'https://github.com/org/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.git',
        created_on_platform: 'cloud-agent-web',
      })
    ).toBe('МЕТАДАННЫЕ');
    expect(
      storedSessionEyebrowLabel({
        git_url: 'git@github.com:org/%E5%B1%B1%E7%94%B0-API.git',
        created_on_platform: 'cli',
      })
    ).toBe('山田-API');
  });
});

describe('remoteSessionEyebrowLabel (canonical eyebrow — repo-name-first)', () => {
  it('returns the uppercased repo name when gitUrl is present (SSH)', () => {
    expect(
      remoteSessionEyebrowLabel({
        gitUrl: 'git@github.com:org/my-repo.git',
        createdOnPlatform: 'cli',
      })
    ).toBe('MY-REPO');
  });

  it('returns the uppercased repo name when gitUrl is present (https)', () => {
    expect(
      remoteSessionEyebrowLabel({
        gitUrl: 'https://github.com/org/my-repo.git',
        createdOnPlatform: 'cloud-agent',
      })
    ).toBe('MY-REPO');
  });

  it('returns "LIVE" when gitUrl is null and origin is undefined (origin-not-heartbeat)', () => {
    expect(remoteSessionEyebrowLabel({ gitUrl: null, createdOnPlatform: undefined })).toBe('LIVE');
  });

  it('returns "LIVE" when gitUrl is undefined and origin is "unknown"', () => {
    expect(remoteSessionEyebrowLabel({ gitUrl: undefined, createdOnPlatform: 'unknown' })).toBe(
      'LIVE'
    );
  });

  it('returns "CLI" when gitUrl is undefined and origin is "cli"', () => {
    expect(remoteSessionEyebrowLabel({ gitUrl: undefined, createdOnPlatform: 'cli' })).toBe('CLI');
  });

  it('returns "CLOUD AGENT" when gitUrl is undefined and origin is "cloud-agent-web"', () => {
    expect(
      remoteSessionEyebrowLabel({ gitUrl: undefined, createdOnPlatform: 'cloud-agent-web' })
    ).toBe('CLOUD AGENT');
  });

  it('shows the decoded repository name for a percent-encoded gitUrl', () => {
    expect(
      remoteSessionEyebrowLabel({
        gitUrl:
          'https://github.com/org/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.git',
        createdOnPlatform: 'cloud-agent-web',
      })
    ).toBe('МЕТАДАННЫЕ');
  });

  it('repo name wins over a known platform origin', () => {
    expect(
      remoteSessionEyebrowLabel({
        gitUrl: 'https://github.com/org/my-repo.git',
        createdOnPlatform: 'cli',
      })
    ).toBe('MY-REPO');
  });
});

describe('eyebrow casing follows the active locale (Turkish i → İ)', () => {
  it('uppercases the stored-session repo name with the locale', async () => {
    await i18n.changeLanguage('tr');
    expect(
      storedSessionEyebrowLabel({
        git_url: 'git@github.com:org/instance.git',
        created_on_platform: 'cli',
      })
    ).toBe('İNSTANCE');
  });

  it('uppercases the remote-session repo name with the locale', async () => {
    await i18n.changeLanguage('tr');
    expect(remoteSessionEyebrowLabel({ gitUrl: 'https://github.com/org/instance.git' })).toBe(
      'İNSTANCE'
    );
  });
});

describe('composeActiveSessionVisibleMeta', () => {
  it('both cost and time → "$cost · timeMeta"', () => {
    expect(composeActiveSessionVisibleMeta('$0.12', '5M AGO')).toBe('$0.12 · 5M AGO');
  });

  it('cost only → cost', () => {
    expect(composeActiveSessionVisibleMeta('$3.50', undefined)).toBe('$3.50');
  });

  it('time only → timeMeta', () => {
    expect(composeActiveSessionVisibleMeta(null, '1H AGO')).toBe('1H AGO');
  });

  it('neither → undefined', () => {
    expect(composeActiveSessionVisibleMeta(null, undefined)).toBeUndefined();
  });

  it('null cost with empty time → undefined', () => {
    expect(composeActiveSessionVisibleMeta(null, '')).toBeUndefined();
  });
});

describe('composeActiveSessionSpokenMeta', () => {
  it('both cost and time → "cost <cost>, <time>"', () => {
    expect(composeActiveSessionSpokenMeta('12 cents', '5 minutes ago')).toBe(
      'cost 12 cents, 5 minutes ago'
    );
  });

  it('cost only → "cost <cost>"', () => {
    expect(composeActiveSessionSpokenMeta('3 dollars', null)).toBe('cost 3 dollars');
  });

  it('time only → timeSpoken', () => {
    expect(composeActiveSessionSpokenMeta(null, '1 hour ago')).toBe('1 hour ago');
  });

  it('neither → null', () => {
    expect(composeActiveSessionSpokenMeta(null, null)).toBeNull();
  });
});

describe('selectRemoteRowSpokenMeta', () => {
  it('keeps metadata clauses separate from the outer Arabic conjunction', async () => {
    await i18n.changeLanguage('ar');
    expect(
      selectRemoteRowSpokenMeta({
        variant: 'list',
        needsInput: false,
        scheduled: true,
        scheduledWake: 'wake',
        costSpoken: null,
        timeSpoken: 'activity',
      })
    ).toBe('wake, activity');
  });

  it('keeps cost and activity alongside a scheduled wake', () => {
    const result = selectRemoteRowSpokenMeta({
      variant: 'list',
      needsInput: false,
      scheduled: true,
      scheduledWake: 'tomorrow',
      costSpoken: '12 cents',
      timeSpoken: '5 minutes ago',
    });
    expect(result).toContain('tomorrow');
    expect(result).toContain('12 cents');
    expect(result).toContain('5 minutes ago');
  });

  it.each([
    {
      variant: 'list',
      needsInput: true,
      scheduled: false,
      scheduledWake: null,
      expected: 'cost 12 cents, 5 minutes ago',
    },
    {
      variant: 'list',
      needsInput: false,
      scheduled: true,
      scheduledWake: null,
      expected: 'cost 12 cents, 5 minutes ago',
    },
    { variant: 'card', needsInput: true, scheduled: false, scheduledWake: null, expected: null },
    {
      variant: 'card',
      needsInput: false,
      scheduled: true,
      scheduledWake: 'tomorrow',
      expected: 'tomorrow',
    },
    { variant: 'card', needsInput: false, scheduled: true, scheduledWake: null, expected: null },
  ] as const)(
    'preserves $variant metadata precedence for needsInput=$needsInput, scheduled=$scheduled, wake=$scheduledWake',
    ({ expected, ...state }) => {
      expect(
        selectRemoteRowSpokenMeta({
          ...state,
          costSpoken: '12 cents',
          timeSpoken: '5 minutes ago',
        })
      ).toBe(expected);
    }
  );
});
