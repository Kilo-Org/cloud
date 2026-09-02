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
  composeSessionProvenanceSubtitle,
  expandPlatformFilter,
  formatMeta,
  remoteAgentLabel,
  remoteMeta,
  remoteSessionEyebrowLabel,
  repoNameFromGitUrl,
  selectRemoteRowSpokenMeta,
  storedSessionEyebrowLabel,
} from './session-list-helpers';

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
