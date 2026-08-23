/* eslint-disable max-lines -- cohesive unit-test suite for session-list-helpers pure functions */
import { describe, expect, it } from 'vitest';

import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp, timeAgo } from '@/lib/utils';

import {
  activeSessionMetaTimestamp,
  canExitSessionFromList,
  composeActiveSessionSpokenMeta,
  composeActiveSessionVisibleMeta,
  excludeActiveFromGroups,
  expandPlatformFilter,
  formatMeta,
  platformLabel,
  remoteAgentLabel,
  remoteMeta,
  remoteSessionEyebrowLabel,
  repoNameFromGitUrl,
  selectPinnedActiveSessions,
  selectRemoteRowSpokenMeta,
  storedSessionEyebrowLabel,
} from './session-list-helpers';
import { type AgentSessionDateGroup } from '@/lib/agent-session-groups';

function makeActive(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

describe('selectPinnedActiveSessions', () => {
  it('does not dedup against stored pages (returns actives regardless)', () => {
    // The helper intentionally has no stored-sessions parameter. The
    // exclusivity contract lives on the history side (Task 3); the pinned
    // set is driven by the search query, the platform/project filters, and the active input.
    const actives: ActiveSession[] = [makeActive({ id: 'a1' }), makeActive({ id: 'a2' })];
    const result = selectPinnedActiveSessions({
      activeSessions: actives,
      projectFilter: [],
      platformFilter: [],
      searchQuery: '',
    });
    expect(result).toEqual(actives);
  });

  describe('search rules', () => {
    it('empty query performs no narrowing', () => {
      const a = makeActive({ id: 'a', title: 'Fix login' });
      const b = makeActive({ id: 'b', title: 'Other work' });
      const result = selectPinnedActiveSessions({
        activeSessions: [a, b],
        projectFilter: [],
        platformFilter: [],
        searchQuery: '',
      });
      expect(result).toEqual([a, b]);
    });

    it('whitespace-only query performs no narrowing', () => {
      const a = makeActive({ id: 'a', title: 'Fix login' });
      const b = makeActive({ id: 'b', title: 'Other work' });
      const result = selectPinnedActiveSessions({
        activeSessions: [a, b],
        projectFilter: [],
        platformFilter: [],
        searchQuery: '   ',
      });
      expect(result).toEqual([a, b]);
    });

    it('matches a title substring mid-string', () => {
      const match = makeActive({ id: 'm', title: 'Fix login bug' });
      const other = makeActive({ id: 'o', title: 'Deploy release' });
      const result = selectPinnedActiveSessions({
        activeSessions: [match, other],
        projectFilter: [],
        platformFilter: [],
        searchQuery: 'login',
      });
      expect(result.map(s => s.id)).toEqual(['m']);
    });

    it('title match is case-insensitive both ways', () => {
      const lower = makeActive({ id: 'lower', title: 'Fix login bug' });
      const upper = makeActive({ id: 'upper', title: 'FIX LOGIN BUG' });
      expect(
        selectPinnedActiveSessions({
          activeSessions: [lower],
          projectFilter: [],
          platformFilter: [],
          searchQuery: 'LOGIN',
        }).map(s => s.id)
      ).toEqual(['lower']);
      expect(
        selectPinnedActiveSessions({
          activeSessions: [upper],
          projectFilter: [],
          platformFilter: [],
          searchQuery: 'fix',
        }).map(s => s.id)
      ).toEqual(['upper']);
    });

    it('matches a session id substring, case-insensitively', () => {
      const match = makeActive({ id: 'ses-ABC123', title: 'Unrelated title' });
      const other = makeActive({ id: 'ses-xyz', title: 'Also unrelated' });
      const result = selectPinnedActiveSessions({
        activeSessions: [match, other],
        projectFilter: [],
        platformFilter: [],
        searchQuery: 'abc123',
      });
      expect(result.map(s => s.id)).toEqual(['ses-ABC123']);
    });

    it('excludes sessions matching neither title nor id', () => {
      const a = makeActive({ id: 'ses-a', title: 'Fix login' });
      const b = makeActive({ id: 'ses-b', title: 'Deploy' });
      const result = selectPinnedActiveSessions({
        activeSessions: [a, b],
        projectFilter: [],
        platformFilter: [],
        searchQuery: 'zzz',
      });
      expect(result).toEqual([]);
    });

    it('applies the text query in conjunction with platform and project filters', () => {
      const pass = makeActive({
        id: 'pass',
        title: 'Fix login bug',
        gitUrl: 'git@github.com:org/repo.git',
        createdOnPlatform: 'cli',
      });
      const wrongPlatform = makeActive({
        id: 'wrongPlatform',
        title: 'Fix login bug',
        gitUrl: 'git@github.com:org/repo.git',
        createdOnPlatform: 'slack',
      });
      const wrongProject = makeActive({
        id: 'wrongProject',
        title: 'Fix login bug',
        gitUrl: 'git@github.com:org/other.git',
        createdOnPlatform: 'cli',
      });
      const result = selectPinnedActiveSessions({
        activeSessions: [pass, wrongPlatform, wrongProject],
        projectFilter: ['git@github.com:org/repo.git'],
        platformFilter: ['cli'],
        searchQuery: 'login',
      });
      expect(result.map(s => s.id)).toEqual(['pass']);
    });

    it('treats LIKE metacharacters literally (parity with server position() search)', () => {
      const percent = makeActive({ id: 'pct', title: '100% done' });
      const noPercent = makeActive({ id: 'nop', title: '1000 done' });
      expect(
        selectPinnedActiveSessions({
          activeSessions: [percent, noPercent],
          projectFilter: [],
          platformFilter: [],
          searchQuery: '100%',
        }).map(s => s.id)
      ).toEqual(['pct']);
    });
  });

  describe('project rules', () => {
    it('excludes rows with missing gitUrl under an active project filter', () => {
      const withUrl = makeActive({ id: 'with', gitUrl: 'git@github.com:org/repo.git' });
      const withoutUrl = makeActive({ id: 'without' });
      const result = selectPinnedActiveSessions({
        activeSessions: [withUrl, withoutUrl],
        projectFilter: ['git@github.com:org/repo.git'],
        platformFilter: [],
        searchQuery: '',
      });
      expect(result.map(s => s.id)).toEqual(['with']);
    });

    it('includes rows whose gitUrl is in the active project filter', () => {
      const match = makeActive({ id: 'match', gitUrl: 'git@github.com:org/repo.git' });
      const other = makeActive({ id: 'other', gitUrl: 'git@github.com:org/other.git' });
      const result = selectPinnedActiveSessions({
        activeSessions: [match, other],
        projectFilter: ['git@github.com:org/repo.git'],
        platformFilter: [],
        searchQuery: '',
      });
      expect(result.map(s => s.id)).toEqual(['match']);
    });

    it('includes every active session when no project filter is set', () => {
      const a = makeActive({ id: 'a' });
      const b = makeActive({ id: 'b', gitUrl: 'git@github.com:org/repo.git' });
      const c = makeActive({ id: 'c', gitUrl: 'git@github.com:org/other.git' });
      const result = selectPinnedActiveSessions({
        activeSessions: [a, b, c],
        projectFilter: [],
        platformFilter: [],
        searchQuery: '',
      });
      expect(result.map(s => s.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('platform rules', () => {
    it('includes rows whose createdOnPlatform matches a concrete filter', () => {
      const cli = makeActive({ id: 'cli', createdOnPlatform: 'cli' });
      const slack = makeActive({ id: 'slack', createdOnPlatform: 'slack' });
      const result = selectPinnedActiveSessions({
        activeSessions: [cli, slack],
        projectFilter: [],
        platformFilter: ['cli'],
        searchQuery: '',
      });
      expect(result.map(s => s.id)).toEqual(['cli']);
    });

    it('expands a cloud-agent filter to also match cloud-agent-web', () => {
      const web = makeActive({ id: 'web', createdOnPlatform: 'cloud-agent-web' });
      const ca = makeActive({ id: 'ca', createdOnPlatform: 'cloud-agent' });
      const result = selectPinnedActiveSessions({
        activeSessions: [web, ca],
        projectFilter: [],
        platformFilter: ['cloud-agent'],
        searchQuery: '',
      });
      expect(result.map(s => s.id).toSorted()).toEqual(['ca', 'web']);
    });

    it('expands an extension filter to vscode and agent-manager', () => {
      const vscode = makeActive({ id: 'vscode', createdOnPlatform: 'vscode' });
      const am = makeActive({ id: 'am', createdOnPlatform: 'agent-manager' });
      const slack = makeActive({ id: 'slack', createdOnPlatform: 'slack' });
      const result = selectPinnedActiveSessions({
        activeSessions: [vscode, am, slack],
        projectFilter: [],
        platformFilter: ['extension'],
        searchQuery: '',
      });
      expect(result.map(s => s.id).toSorted()).toEqual(['am', 'vscode']);
    });

    it("'other' filter matches an unknown platform", () => {
      const weird = makeActive({ id: 'weird', createdOnPlatform: 'my-new-platform' });
      const result = selectPinnedActiveSessions({
        activeSessions: [weird],
        projectFilter: [],
        platformFilter: ['other'],
        searchQuery: '',
      });
      expect(result.map(s => s.id)).toEqual(['weird']);
    });

    it("'other' filter rejects a known platform", () => {
      const cli = makeActive({ id: 'cli', createdOnPlatform: 'cli' });
      const result = selectPinnedActiveSessions({
        activeSessions: [cli],
        projectFilter: [],
        platformFilter: ['other'],
        searchQuery: '',
      });
      expect(result).toEqual([]);
    });

    it("'other' combined with a concrete filter accepts both", () => {
      const cli = makeActive({ id: 'cli', createdOnPlatform: 'cli' });
      const weird = makeActive({ id: 'weird', createdOnPlatform: 'my-new-platform' });
      const vscode = makeActive({ id: 'vscode', createdOnPlatform: 'vscode' });
      const result = selectPinnedActiveSessions({
        activeSessions: [cli, weird, vscode],
        projectFilter: [],
        platformFilter: ['cli', 'other'],
        searchQuery: '',
      });
      expect(result.map(s => s.id).toSorted()).toEqual(['cli', 'weird']);
    });

    it('excludes rows with undefined createdOnPlatform under any platform filter', () => {
      const unknown = makeActive({ id: 'unknown' });
      const cli = makeActive({ id: 'cli', createdOnPlatform: 'cli' });
      const result = selectPinnedActiveSessions({
        activeSessions: [unknown, cli],
        projectFilter: [],
        platformFilter: ['cli'],
        searchQuery: '',
      });
      expect(result.map(s => s.id)).toEqual(['cli']);
    });

    it('includes rows with undefined createdOnPlatform when no platform filter is set', () => {
      const unknown = makeActive({ id: 'unknown' });
      const cli = makeActive({ id: 'cli', createdOnPlatform: 'cli' });
      const result = selectPinnedActiveSessions({
        activeSessions: [unknown, cli],
        projectFilter: [],
        platformFilter: [],
        searchQuery: '',
      });
      expect(result.map(s => s.id).toSorted()).toEqual(['cli', 'unknown']);
    });
  });

  it('combines project and platform filters with AND semantics', () => {
    const pass = makeActive({
      id: 'pass',
      gitUrl: 'git@github.com:org/repo.git',
      createdOnPlatform: 'cli',
    });
    const wrongProject = makeActive({
      id: 'wrongProject',
      gitUrl: 'git@github.com:org/other.git',
      createdOnPlatform: 'cli',
    });
    const wrongPlatform = makeActive({
      id: 'wrongPlatform',
      gitUrl: 'git@github.com:org/repo.git',
      createdOnPlatform: 'slack',
    });
    const result = selectPinnedActiveSessions({
      activeSessions: [pass, wrongProject, wrongPlatform],
      projectFilter: ['git@github.com:org/repo.git'],
      platformFilter: ['cli'],
      searchQuery: '',
    });
    expect(result.map(s => s.id)).toEqual(['pass']);
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

describe('platformLabel (moved helper, regression guard)', () => {
  it('matches the original mapping', () => {
    expect(platformLabel('cloud-agent')).toBe('CLOUD AGENT');
    expect(platformLabel('cloud-agent-web')).toBe('CLOUD AGENT');
    expect(platformLabel('vscode')).toBe('VSCODE');
    expect(platformLabel('agent-manager')).toBe('VSCODE');
    expect(platformLabel('slack')).toBe('SLACK');
    expect(platformLabel('cli')).toBe('CLI');
    expect(platformLabel('my-new-platform')).toBe('MY-NEW-PLATFORM');
  });
});

describe('formatMeta (moved helper, regression guard)', () => {
  it('matches the original timeAgo + toUpperCase behavior', () => {
    expect(formatMeta('2024-01-01T00:00:00.000Z')).toBe(
      timeAgo(parseTimestamp('2024-01-01T00:00:00.000Z')).toUpperCase()
    );
  });
});

type ExcludeRow = { session_id: string; created_at: string; updated_at: string };

function makeGroup(label: string, ids: string[]): AgentSessionDateGroup<ExcludeRow> {
  return {
    label,
    sessions: ids.map(id => ({ session_id: id, created_at: '', updated_at: '' })),
  };
}

describe('excludeActiveFromGroups', () => {
  type Row = ExcludeRow;

  it('drops matching sessions and drops groups that become empty', () => {
    const groups: AgentSessionDateGroup<Row>[] = [
      makeGroup('Today', ['a', 'b', 'c']),
      makeGroup('Yesterday', ['d', 'e']),
      makeGroup('Older', ['f']),
    ];
    const result = excludeActiveFromGroups(groups, new Set(['b', 'e', 'f']));
    expect(result.map(g => g.label)).toEqual(['Today', 'Yesterday']);
    expect(result[0]?.sessions.map(s => s.session_id)).toEqual(['a', 'c']);
    expect(result[1]?.sessions.map(s => s.session_id)).toEqual(['d']);
  });

  it('preserves order when nothing is excluded', () => {
    const groups: AgentSessionDateGroup<Row>[] = [
      makeGroup('Today', ['a']),
      makeGroup('Yesterday', ['b']),
      makeGroup('Older', ['c']),
    ];
    const result = excludeActiveFromGroups(groups, new Set());
    expect(result.map(g => g.label)).toEqual(['Today', 'Yesterday', 'Older']);
    expect(result.map(g => g.sessions.map(s => s.session_id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('returns an empty array when every session is active', () => {
    const groups: AgentSessionDateGroup<Row>[] = [
      makeGroup('Today', ['a']),
      makeGroup('Yesterday', ['b']),
    ];
    const result = excludeActiveFromGroups(groups, new Set(['a', 'b']));
    expect(result).toEqual([]);
  });

  it('preserves group label and remaining session order when partially excluded', () => {
    const groups: AgentSessionDateGroup<Row>[] = [
      makeGroup('Today', ['x', 'y', 'z']),
      makeGroup('Older', ['p', 'q']),
    ];
    const result = excludeActiveFromGroups(groups, new Set(['y']));
    expect(result.map(g => g.label)).toEqual(['Today', 'Older']);
    expect(result[0]?.sessions.map(s => s.session_id)).toEqual(['x', 'z']);
    expect(result[1]?.sessions.map(s => s.session_id)).toEqual(['p', 'q']);
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

  it('repo name wins over a known platform origin', () => {
    expect(
      remoteSessionEyebrowLabel({
        gitUrl: 'https://github.com/org/my-repo.git',
        createdOnPlatform: 'cli',
      })
    ).toBe('MY-REPO');
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
  const costSpoken = '12 cents';
  const timeSpoken = '5 minutes ago';

  it('needsInput + cost + time → null', () => {
    expect(selectRemoteRowSpokenMeta({ needsInput: true, costSpoken, timeSpoken })).toBeNull();
  });

  it('needsInput + cost only → null', () => {
    expect(
      selectRemoteRowSpokenMeta({ needsInput: true, costSpoken, timeSpoken: null })
    ).toBeNull();
  });

  it('needsInput + time only → null', () => {
    expect(
      selectRemoteRowSpokenMeta({ needsInput: true, costSpoken: null, timeSpoken })
    ).toBeNull();
  });

  it('needsInput + neither → null', () => {
    expect(
      selectRemoteRowSpokenMeta({ needsInput: true, costSpoken: null, timeSpoken: null })
    ).toBeNull();
  });

  it('cost + time → combined spoken form', () => {
    expect(selectRemoteRowSpokenMeta({ needsInput: false, costSpoken, timeSpoken })).toBe(
      'cost 12 cents, 5 minutes ago'
    );
  });

  it('cost only → spoken cost alone', () => {
    expect(selectRemoteRowSpokenMeta({ needsInput: false, costSpoken, timeSpoken: null })).toBe(
      'cost 12 cents'
    );
  });

  it('time only → spoken time alone', () => {
    expect(selectRemoteRowSpokenMeta({ needsInput: false, costSpoken: null, timeSpoken })).toBe(
      '5 minutes ago'
    );
  });

  it('neither → null', () => {
    expect(
      selectRemoteRowSpokenMeta({ needsInput: false, costSpoken: null, timeSpoken: null })
    ).toBeNull();
  });
});
