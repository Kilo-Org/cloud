/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock settles without await because it resolves immediately */
import { describe, expect, it, vi } from 'vitest';

import {
  activeSessionSearchDocument,
  findingSearchDocument,
  inboxPrSearchDocument,
  planSystemSearchUpdate,
  recentPrSearchDocument,
  storedSessionSearchDocument,
  systemSearchDeeplinkFromId,
  type SystemSearchDocument,
  systemSearchHrefFromId,
} from './system-search-entries';

// `system-search-entries` reuses `providerRefFromRecentPr` from the recents
// module, which opens SecureStore on import. The native module is not
// available under Node, and the builders here never read storage.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

function sessionDocument(id: string, title: string): SystemSearchDocument {
  const document = storedSessionSearchDocument({ session_id: id, title });
  if (document === null) {
    throw new Error(`expected a session document for ${id}`);
  }
  return document;
}

function idsOf(documents: readonly SystemSearchDocument[]): string[] {
  return documents.map(document => document.id);
}

describe('session documents', () => {
  it('keeps the organization context in an org-scoped session id', () => {
    const document = storedSessionSearchDocument({
      session_id: 'sess-1',
      title: 'Fix login bug',
      organization_id: 'org-1',
      git_branch: 'feature/live',
    });

    expect(document?.id).toBe('/(app)/agent-chat/sess-1?organizationId=org-1');
    expect(document?.title).toBe('Fix login bug');
    expect(document?.description).toBe('feature/live');
    expect(document?.keywords).toEqual([]);
  });

  it('builds the personal session id without an organization context', () => {
    const document = storedSessionSearchDocument({
      session_id: 'sess-2',
      title: 'Personal work',
      organization_id: null,
      git_branch: null,
    });

    expect(document?.id).toBe('/(app)/agent-chat/sess-2');
    expect(document?.description).toBe('');
  });

  it('skips a session with an empty or whitespace title', () => {
    expect(storedSessionSearchDocument({ session_id: 'a', title: '' })).toBeNull();
    expect(storedSessionSearchDocument({ session_id: 'b', title: '   ' })).toBeNull();
    expect(storedSessionSearchDocument({ session_id: 'c', title: null })).toBeNull();
  });

  it('builds the live-session document from the camelCase active row', () => {
    const document = activeSessionSearchDocument({
      id: 'live-1',
      title: 'Watch the deploy',
      organizationId: 'org-9',
      gitBranch: 'release',
    });

    expect(document?.id).toBe('/(app)/agent-chat/live-1?organizationId=org-9');
    expect(document?.description).toBe('release');
  });

  it('skips an untitled live session', () => {
    expect(activeSessionSearchDocument({ id: 'live-2', title: '  ' })).toBeNull();
  });
});

describe('pull request documents', () => {
  it('builds an inbox row through the GitHub route builder', () => {
    const document = inboxPrSearchDocument({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
      title: 'Hello PR',
    });

    expect(document.id).toBe('/(app)/pr-review/octocat/hello-world/42');
    expect(document.title).toBe('Hello PR');
    expect(document.description).toBe('octocat/hello-world#42');
    expect(document.keywords).toEqual(['octocat/hello-world', '42']);
  });

  it('routes a GitHub recents entry to the same route as the inbox row', () => {
    const document = recentPrSearchDocument({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
      title: 'Hello PR',
    });

    expect(document.id).toBe('/(app)/pr-review/octocat/hello-world/42');
  });

  it('keeps the provider route for a GitLab recents entry', () => {
    const document = recentPrSearchDocument({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      title: 'Nested MR',
      platform: 'gitlab',
      instanceHint: 'https://gitlab.example.com',
    });

    expect(document.id).toBe(
      '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
    );
    expect(document.description).toBe('group/sub/repo!12');
  });

  it('keeps the provider route for a Bitbucket recents entry', () => {
    const document = recentPrSearchDocument({
      owner: 'workspace',
      repo: 'repo',
      number: 7,
      title: 'Bitbucket PR',
      platform: 'bitbucket',
    });

    expect(document.id).toBe('/(app)/pr-review/bitbucket/workspace/repo/7');
    expect(document.description).toBe('workspace/repo#7');
  });
});

describe('finding documents', () => {
  it('builds the personal-scope finding route', () => {
    const document = findingSearchDocument(
      { id: 'finding-1', title: 'SQL injection', severity: 'critical', repo_full_name: 'acme/api' },
      'personal'
    );

    expect(document.id).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1'
    );
    expect(document.description).toBe('acme/api · critical');
    expect(document.keywords).toEqual(['acme/api', 'critical']);
  });

  it('builds the organization-scope finding route', () => {
    const document = findingSearchDocument(
      { id: 'finding-2', title: 'XSS', severity: 'high', repo_full_name: 'acme/web' },
      'org-1'
    );

    expect(document.id).toBe('/(app)/(tabs)/(3_profile)/security-agent/org-1/findings/finding-2');
  });

  it('omits a missing severity from the description', () => {
    const document = findingSearchDocument(
      { id: 'finding-3', title: 'No severity', severity: null, repo_full_name: 'acme/api' },
      'personal'
    );

    expect(document.description).toBe('acme/api');
    expect(document.keywords).toEqual(['acme/api']);
  });
});

describe('fingerprints', () => {
  it('is the same for the same content under different ids', () => {
    // The id is the route, not content: a session that keeps its text keeps
    // its fingerprint even though the row it came from is a different row.
    expect(sessionDocument('a', 'Alpha').fingerprint).toBe(
      sessionDocument('b', 'Alpha').fingerprint
    );
  });

  it('changes when the description changes', () => {
    const withBranch = storedSessionSearchDocument({
      session_id: 'a',
      title: 'Alpha',
      git_branch: 'main',
    });

    expect(withBranch?.fingerprint).not.toBe(sessionDocument('a', 'Alpha').fingerprint);
  });
});

describe('planSystemSearchUpdate', () => {
  it('adds an unknown id', () => {
    const next = sessionDocument('a', 'Alpha');
    const plan = planSystemSearchUpdate({ indexed: [], documents: [next] });

    expect(plan.add).toEqual([next]);
    expect(plan.remove).toEqual([]);
  });

  it('adds nothing when the fingerprint is unchanged', () => {
    const current = sessionDocument('a', 'Alpha');
    const plan = planSystemSearchUpdate({
      indexed: [current],
      documents: [sessionDocument('a', 'Alpha')],
    });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('re-adds a renamed row with a new fingerprint', () => {
    const current = sessionDocument('a', 'Alpha');
    const renamed = sessionDocument('a', 'Renamed');
    const plan = planSystemSearchUpdate({ indexed: [current], documents: [renamed] });

    expect(plan.add).toEqual([renamed]);
    expect(plan.add[0]?.fingerprint).not.toBe(current.fingerprint);
    expect(plan.remove).toEqual([]);
  });

  it('removes an indexed id the documents no longer carry', () => {
    const kept = sessionDocument('a', 'Alpha');
    const vanished = sessionDocument('b', 'Beta');
    const plan = planSystemSearchUpdate({ indexed: [kept, vanished], documents: [kept] });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([vanished.id]);
  });

  it('removes everything when the document set is empty', () => {
    const plan = planSystemSearchUpdate({
      indexed: [sessionDocument('a', 'Alpha'), sessionDocument('b', 'Beta')],
      documents: [],
    });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual(['/(app)/agent-chat/a', '/(app)/agent-chat/b']);
  });

  it('dedupes documents by id, keeping the first occurrence', () => {
    const plan = planSystemSearchUpdate({
      indexed: [],
      documents: [sessionDocument('a', 'Alpha'), sessionDocument('a', 'Second')],
    });

    expect(idsOf(plan.add)).toEqual(['/(app)/agent-chat/a']);
    expect(plan.add[0]?.title).toBe('Alpha');
  });
});

describe('systemSearchHrefFromId', () => {
  it('resolves each known route shape', () => {
    const ids = [
      '/(app)/agent-chat/sess-1?organizationId=org-1',
      '/(app)/pr-review/octocat/hello-world/42',
      '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1',
    ];

    for (const id of ids) {
      expect(systemSearchHrefFromId(id)).toBe(id);
    }
  });

  it('returns null for an unrecognised identifier', () => {
    expect(systemSearchHrefFromId('https://example.com/agent-chat/sess-1')).toBeNull();
    expect(systemSearchHrefFromId('/(app)/settings')).toBeNull();
    expect(systemSearchHrefFromId('/(app)/agent-chat/')).toBeNull();
    expect(systemSearchHrefFromId('kiloapp://agent-chat/sess-1')).toBeNull();
  });

  it('accepts every id the builders produce', () => {
    const documents = [
      sessionDocument('a', 'Alpha'),
      inboxPrSearchDocument({ owner: 'o', repo: 'r', number: 1, title: 'PR' }),
      findingSearchDocument({ id: 'f', title: 'Finding', severity: 'low' }, 'personal'),
    ];

    for (const document of documents) {
      expect(systemSearchHrefFromId(document.id)).toBe(document.id);
    }
  });
});

describe('systemSearchDeeplinkFromId', () => {
  it('strips the group segments from each known route shape', () => {
    expect(systemSearchDeeplinkFromId('/(app)/agent-chat/sess-1?organizationId=org-1')).toBe(
      'kiloapp://agent-chat/sess-1?organizationId=org-1'
    );
    expect(systemSearchDeeplinkFromId('/(app)/pr-review/octocat/hello-world/42')).toBe(
      'kiloapp://pr-review/octocat/hello-world/42'
    );
    expect(
      systemSearchDeeplinkFromId(
        '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1'
      )
    ).toBe('kiloapp://security-agent/personal/findings/finding-1');
  });

  it('returns null for an unrecognised identifier', () => {
    expect(systemSearchDeeplinkFromId('/(app)/settings')).toBeNull();
  });

  it('builds a deeplink for every id the builders produce', () => {
    const documents = [
      sessionDocument('a', 'Alpha'),
      inboxPrSearchDocument({ owner: 'o', repo: 'r', number: 1, title: 'PR' }),
      findingSearchDocument({ id: 'f', title: 'Finding', severity: 'low' }, 'org-1'),
    ];

    for (const document of documents) {
      const deeplink = systemSearchDeeplinkFromId(document.id);
      expect(deeplink?.startsWith('kiloapp://')).toBe(true);
      expect(deeplink).not.toContain('(app)');
      expect(deeplink).not.toContain('(tabs)');
    }
  });
});
