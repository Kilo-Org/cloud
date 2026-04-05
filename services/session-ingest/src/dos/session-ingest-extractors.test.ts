import { describe, it, expect } from 'vitest';
import type { IngestBatch } from '../types/session-sync';
import {
  extractNormalizedTitleFromItem,
  extractNormalizedParentIdFromItem,
  extractNormalizedPlatformFromItem,
  extractNormalizedOrgIdFromItem,
  extractNormalizedGitUrlFromItem,
  extractNormalizedGitBranchFromItem,
} from './session-ingest-extractors';

function sessionItem(data: Record<string, unknown>): IngestBatch[number] {
  return { type: 'session', data } as IngestBatch[number];
}

function kiloMetaItem(data: {
  platform: string;
  orgId?: string;
  gitUrl?: string | null;
  gitBranch?: string | null;
}): IngestBatch[number] {
  return { type: 'kilo_meta', data } as IngestBatch[number];
}

function messageItem(): IngestBatch[number] {
  return { type: 'message', data: { id: 'msg-1' } } as IngestBatch[number];
}

describe('extractNormalizedTitleFromItem', () => {
  it('extracts title from session item', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: 'My Session' }))).toBe('My Session');
  });

  it('trims whitespace from title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: '  hello  ' }))).toBe('hello');
  });

  it('returns null for empty string title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: '' }))).toBeNull();
  });

  it('returns null for whitespace-only title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: '   ' }))).toBeNull();
  });

  it('returns undefined for session item with no title field', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({}))).toBeUndefined();
  });

  it('returns undefined for non-session item', () => {
    expect(extractNormalizedTitleFromItem(messageItem())).toBeUndefined();
  });

  it('returns null for null title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: null }))).toBeNull();
  });

  it('returns undefined for numeric title', () => {
    expect(extractNormalizedTitleFromItem(sessionItem({ title: 42 }))).toBeUndefined();
  });
});

describe('extractNormalizedParentIdFromItem', () => {
  it('extracts parentID from session item', () => {
    expect(extractNormalizedParentIdFromItem(sessionItem({ parentID: 'parent-1' }))).toBe(
      'parent-1'
    );
  });

  it('returns null for empty parentID', () => {
    expect(extractNormalizedParentIdFromItem(sessionItem({ parentID: '' }))).toBeNull();
  });

  it('returns undefined for session item with no parentID', () => {
    expect(extractNormalizedParentIdFromItem(sessionItem({}))).toBeUndefined();
  });

  it('returns undefined for non-session item', () => {
    expect(extractNormalizedParentIdFromItem(messageItem())).toBeUndefined();
  });
});

describe('extractNormalizedPlatformFromItem', () => {
  it('extracts platform from kilo_meta item', () => {
    expect(extractNormalizedPlatformFromItem(kiloMetaItem({ platform: 'vscode' }))).toBe('vscode');
  });

  it('returns undefined for non-kilo_meta item', () => {
    expect(extractNormalizedPlatformFromItem(sessionItem({}))).toBeUndefined();
  });

  it('trims whitespace from platform', () => {
    expect(extractNormalizedPlatformFromItem(kiloMetaItem({ platform: '  cli  ' }))).toBe('cli');
  });
});

describe('extractNormalizedOrgIdFromItem', () => {
  it('extracts orgId from kilo_meta item', () => {
    expect(
      extractNormalizedOrgIdFromItem(kiloMetaItem({ platform: 'cli', orgId: 'org-123' }))
    ).toBe('org-123');
  });

  it('returns undefined for kilo_meta item without orgId', () => {
    expect(extractNormalizedOrgIdFromItem(kiloMetaItem({ platform: 'cli' }))).toBeUndefined();
  });

  it('returns undefined for non-kilo_meta item', () => {
    expect(extractNormalizedOrgIdFromItem(messageItem())).toBeUndefined();
  });
});

describe('extractNormalizedGitUrlFromItem', () => {
  it('extracts gitUrl from kilo_meta item', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: 'https://github.com/user/repo' })
      )
    ).toBe('https://github.com/user/repo');
  });

  it('strips credentials from HTTPS git url', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: 'https://token@github.com/user/repo' })
      )
    ).toBe('https://github.com/user/repo');
  });

  it('strips credentials, query params, and hash from HTTPS git url', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({
          platform: 'cli',
          gitUrl: 'https://user:pass@github.com/org/repo.git?ref=main#L10',
        })
      )
    ).toBe('https://github.com/org/repo.git');
  });

  it('strips query params and hash from HTTPS git url without credentials', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: 'https://github.com/org/repo?token=abc#readme' })
      )
    ).toBe('https://github.com/org/repo');
  });

  it('accepts SSH git url', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: 'git@github.com:user/repo.git' })
      )
    ).toBe('git@github.com:user/repo.git');
  });

  it('strips query params from SSH git url', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: 'git@github.com:org/repo.git?ref=main' })
      )
    ).toBe('git@github.com:org/repo.git');
  });

  it('handles SSH git url with subgroups', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: 'git@gitlab.com:group/subgroup/repo.git' })
      )
    ).toBe('git@gitlab.com:group/subgroup/repo.git');
  });

  it('returns null for invalid git url', () => {
    expect(
      extractNormalizedGitUrlFromItem(kiloMetaItem({ platform: 'cli', gitUrl: 'not-a-url' }))
    ).toBeNull();
  });

  it('returns undefined for kilo_meta item without gitUrl', () => {
    expect(extractNormalizedGitUrlFromItem(kiloMetaItem({ platform: 'cli' }))).toBeUndefined();
  });

  it('returns undefined for non-kilo_meta item', () => {
    expect(extractNormalizedGitUrlFromItem(messageItem())).toBeUndefined();
  });

  it('returns null for empty string gitUrl', () => {
    expect(
      extractNormalizedGitUrlFromItem(kiloMetaItem({ platform: 'cli', gitUrl: '' }))
    ).toBeNull();
  });

  it('trims whitespace from gitUrl', () => {
    expect(
      extractNormalizedGitUrlFromItem(
        kiloMetaItem({ platform: 'cli', gitUrl: '  https://github.com/user/repo  ' })
      )
    ).toBe('https://github.com/user/repo');
  });
});

describe('extractNormalizedGitBranchFromItem', () => {
  it('extracts gitBranch from kilo_meta item', () => {
    expect(
      extractNormalizedGitBranchFromItem(kiloMetaItem({ platform: 'cli', gitBranch: 'main' }))
    ).toBe('main');
  });

  it('trims whitespace from gitBranch', () => {
    expect(
      extractNormalizedGitBranchFromItem(
        kiloMetaItem({ platform: 'cli', gitBranch: '  feature/test  ' })
      )
    ).toBe('feature/test');
  });

  it('returns null for empty string gitBranch', () => {
    expect(
      extractNormalizedGitBranchFromItem(kiloMetaItem({ platform: 'cli', gitBranch: '' }))
    ).toBeNull();
  });

  it('returns undefined for kilo_meta item without gitBranch', () => {
    expect(extractNormalizedGitBranchFromItem(kiloMetaItem({ platform: 'cli' }))).toBeUndefined();
  });

  it('returns undefined for non-kilo_meta item', () => {
    expect(extractNormalizedGitBranchFromItem(messageItem())).toBeUndefined();
  });

  it('returns null for null gitBranch', () => {
    expect(
      extractNormalizedGitBranchFromItem(kiloMetaItem({ platform: 'cli', gitBranch: null }))
    ).toBeNull();
  });
});
