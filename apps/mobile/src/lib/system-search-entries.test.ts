/* eslint-disable max-lines -- the builder, fingerprint, plan, and allowlist suites share one owned file */
/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock settles without await because it resolves immediately */
import { describe, expect, it, vi } from 'vitest';

import {
  activeSessionSearchDocument,
  findingSearchDocument,
  inboxPrSearchDocument,
  planSystemSearchUpdate,
  recentPrSearchDocument,
  recentsSourceScope,
  storedSessionSearchDocument,
  systemSearchDeeplinkFromId,
  type SystemSearchDocument,
  systemSearchHrefFromId,
  systemSearchSourceKey,
  systemSearchSourceKeysOfId,
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
    expect(document?.route).toBe('kiloapp://agent-chat/sess-1?organizationId=org-1');
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
    expect(document?.route).toBe('kiloapp://agent-chat/sess-2');
  });

  it('skips a session with an empty or whitespace title', () => {
    expect(storedSessionSearchDocument({ session_id: 'a', title: '' })).toBeNull();
    expect(storedSessionSearchDocument({ session_id: 'b', title: '   ' })).toBeNull();
    expect(storedSessionSearchDocument({ session_id: 'c', title: null })).toBeNull();
  });

  it('skips a session whose title is the backend creation placeholder', () => {
    // `New session - <ISO>` is machine copy, not a name the user could search
    // for, so it is indexed exactly like a title-less row: not at all.
    const placeholder = 'New session - 2026-09-22T04:17:22.503Z';
    expect(storedSessionSearchDocument({ session_id: 'x', title: placeholder })).toBeNull();
    expect(
      activeSessionSearchDocument({ id: 'live-x', title: placeholder, organizationId: null })
    ).toBeNull();
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

  it('skips a live session the WS push path left unattributed', () => {
    // `undefined` organizationId means the row cannot say whether it is
    // personal; indexing it would file an org session under a personal route.
    expect(activeSessionSearchDocument({ id: 'live-3', title: 'Org session' })).toBeNull();
    // `null` is an explicit personal attribution and is indexed as personal.
    expect(
      activeSessionSearchDocument({ id: 'live-4', title: 'Personal session', organizationId: null })
        ?.id
    ).toBe('/(app)/agent-chat/live-4');
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
    expect(document.route).toBe('kiloapp://pr-review/octocat/hello-world/42');
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
    expect(document.route).toBe(
      'kiloapp://pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
    );
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
    expect(document.route).toBe('kiloapp://pr-review/bitbucket/workspace/repo/7');
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
    expect(document.route).toBe('kiloapp://security-agent/personal/findings/finding-1');
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
  it('is the same for the same content under the same route', () => {
    // Two independently built documents for the same entity: the row reaches
    // the builder with and without an explicit personal organization, so the
    // two sides are not the same call.
    const collected = storedSessionSearchDocument({
      session_id: 'a',
      title: 'Alpha',
      organization_id: null,
    });
    const reCollected = storedSessionSearchDocument({ session_id: 'a', title: 'Alpha' });

    expect(collected).not.toBeNull();
    expect(reCollected).not.toBeNull();
    expect(collected?.fingerprint).toBe(reCollected?.fingerprint);

    // What the diff relies on: a row re-collected unchanged is not re-added.
    expect(
      planSystemSearchUpdate({
        indexed: collected ? [collected] : [],
        documents: reCollected ? [reCollected] : [],
        observedSources: new Set([systemSearchSourceKey('sessions', 'personal')]),
      })
    ).toEqual({ add: [], remove: [] });
  });

  it('changes when the route changes, because the route is part of it', () => {
    // The route belongs to the fingerprint: an entry the index holds under a
    // different route is re-added instead of kept stale.
    expect(sessionDocument('a', 'Alpha').fingerprint).not.toBe(
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

  it('carries the route, so an index built before routes existed re-adds', () => {
    const document = sessionDocument('a', 'Alpha');

    expect(JSON.parse(document.fingerprint)).toMatchObject({
      route: 'kiloapp://agent-chat/a',
    });
    // The exact fingerprint the route-less form produced for this content.
    expect(document.fingerprint).not.toBe(
      JSON.stringify({ title: 'Alpha', description: '', keywords: [] })
    );
  });
});

describe('planSystemSearchUpdate', () => {
  // The source scopes the fixtures below belong to: the personal session and
  // finding scopes, and the GitHub pull-request provider.
  const ALL_SOURCES = new Set([
    systemSearchSourceKey('sessions', 'personal'),
    systemSearchSourceKey('pullRequests', 'github'),
    systemSearchSourceKey('findings', 'personal'),
  ]);

  it('adds an unknown id', () => {
    const next = sessionDocument('a', 'Alpha');
    const plan = planSystemSearchUpdate({
      indexed: [],
      documents: [next],
      observedSources: ALL_SOURCES,
    });

    expect(plan.add).toEqual([next]);
    expect(plan.remove).toEqual([]);
  });

  it('adds nothing when the fingerprint is unchanged', () => {
    const current = sessionDocument('a', 'Alpha');
    const plan = planSystemSearchUpdate({
      indexed: [current],
      documents: [sessionDocument('a', 'Alpha')],
      observedSources: ALL_SOURCES,
    });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('re-adds a renamed row with a new fingerprint', () => {
    const current = sessionDocument('a', 'Alpha');
    const renamed = sessionDocument('a', 'Renamed');
    const plan = planSystemSearchUpdate({
      indexed: [current],
      documents: [renamed],
      observedSources: ALL_SOURCES,
    });

    expect(plan.add).toEqual([renamed]);
    expect(plan.add[0]?.fingerprint).not.toBe(current.fingerprint);
    expect(plan.remove).toEqual([]);
  });

  it('removes an indexed id the documents no longer carry', () => {
    const kept = sessionDocument('a', 'Alpha');
    const vanished = sessionDocument('b', 'Beta');
    const plan = planSystemSearchUpdate({
      indexed: [kept, vanished],
      documents: [kept],
      observedSources: ALL_SOURCES,
    });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([vanished.id]);
  });

  it('keeps an indexed id whose source family was not enumerated', () => {
    const kept = sessionDocument('a', 'Alpha');
    const finding = findingSearchDocument({ id: 'f-1', title: 'SQL injection' }, 'personal');
    const plan = planSystemSearchUpdate({
      indexed: [kept, finding],
      documents: [kept],
      // The findings query was not in the cache this run: its absence from the
      // documents is ignorance, not evidence the user lost the finding.
      observedSources: new Set([systemSearchSourceKey('sessions', 'personal')]),
    });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('removes everything when the document set is empty', () => {
    const plan = planSystemSearchUpdate({
      indexed: [sessionDocument('a', 'Alpha'), sessionDocument('b', 'Beta')],
      documents: [],
      observedSources: ALL_SOURCES,
    });

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual(['/(app)/agent-chat/a', '/(app)/agent-chat/b']);
  });

  it('keeps a finding whose own organization scope was not enumerated', () => {
    const personal = findingSearchDocument({ id: 'f-1', title: 'SQL injection' }, 'personal');
    const organization = findingSearchDocument({ id: 'f-2', title: 'XSS' }, 'org-1');
    const plan = planSystemSearchUpdate({
      indexed: [personal, organization],
      documents: [],
      // Only the personal list enumerated: the organization's absence from the
      // documents is ignorance, so its entry stays.
      observedSources: new Set([systemSearchSourceKey('findings', 'personal')]),
    });

    expect(plan.remove).toEqual([personal.id]);
  });

  it('keeps a GitLab pull request when only the GitHub provider was enumerated', () => {
    const github = inboxPrSearchDocument({ owner: 'o', repo: 'r', number: 1, title: 'PR' });
    const gitlab = recentPrSearchDocument({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      title: 'Nested MR',
      platform: 'gitlab',
    });
    const plan = planSystemSearchUpdate({
      indexed: [github, gitlab],
      documents: [],
      observedSources: new Set([systemSearchSourceKey('pullRequests', 'github')]),
    });

    expect(plan.remove).toEqual([github.id]);
  });

  it('removes a GitLab recents entry once the recents list was read', () => {
    const gitlab = recentPrSearchDocument({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      title: 'Nested MR',
      platform: 'gitlab',
    });
    const plan = planSystemSearchUpdate({
      indexed: [gitlab],
      documents: [],
      // The stored recents list is read whole, so its per-provider scope is
      // observed even though no inbox query enumerates it.
      observedSources: new Set([recentsSourceScope('gitlab')]),
    });

    expect(plan.remove).toEqual([gitlab.id]);
  });

  it('removes a Bitbucket recents entry once the recents list was read', () => {
    const bitbucket = recentPrSearchDocument({
      owner: 'workspace',
      repo: 'repo',
      number: 7,
      title: 'Bitbucket PR',
      platform: 'bitbucket',
    });
    const plan = planSystemSearchUpdate({
      indexed: [bitbucket],
      documents: [],
      observedSources: new Set([recentsSourceScope('bitbucket')]),
    });

    expect(plan.remove).toEqual([bitbucket.id]);
  });

  it('keeps a recents entry whose provider scope was not read', () => {
    const gitlab = recentPrSearchDocument({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      title: 'Nested MR',
      platform: 'gitlab',
    });
    const plan = planSystemSearchUpdate({
      indexed: [gitlab],
      documents: [],
      // A read that failed observes no recents scope, so nothing is removed on
      // the strength of a list the app could not read.
      observedSources: new Set(),
    });

    expect(plan.remove).toEqual([]);
  });

  it('dedupes documents by id, keeping the first occurrence', () => {
    const plan = planSystemSearchUpdate({
      indexed: [],
      documents: [sessionDocument('a', 'Alpha'), sessionDocument('a', 'Second')],
      observedSources: ALL_SOURCES,
    });

    expect(idsOf(plan.add)).toEqual(['/(app)/agent-chat/a']);
    expect(plan.add[0]?.title).toBe('Alpha');
  });
});

describe('systemSearchSourceKeysOfId', () => {
  it('reads the scope out of each indexed id shape', () => {
    expect(systemSearchSourceKeysOfId('/(app)/agent-chat/sess-1?organizationId=org-1')).toEqual([
      systemSearchSourceKey('sessions', 'org-1'),
    ]);
    expect(systemSearchSourceKeysOfId('/(app)/agent-chat/sess-1')).toEqual([
      systemSearchSourceKey('sessions', 'personal'),
    ]);
    expect(systemSearchSourceKeysOfId('/(app)/pr-review/octocat/hello-world/42')).toEqual([
      systemSearchSourceKey('pullRequests', 'github'),
    ]);
    expect(systemSearchSourceKeysOfId('/(app)/pr-review/gitlab/group/repo/12')).toEqual([
      systemSearchSourceKey('pullRequests', 'gitlab'),
    ]);
    expect(
      systemSearchSourceKeysOfId('/(app)/(tabs)/(3_profile)/security-agent/org-1/findings/f-2')
    ).toEqual([systemSearchSourceKey('findings', 'org-1')]);
  });

  it('returns no source for an identifier this section did not issue', () => {
    expect(systemSearchSourceKeysOfId('/(app)/settings')).toEqual([]);
    expect(systemSearchSourceKeysOfId('kiloapp://agent-chat/sess-1')).toEqual([]);
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

  it('rejects an id that names more than the three route shapes', () => {
    // A route prefix, not the shape: extra segments and traversal segments are
    // not ids this section issued and must never reach `router.navigate`.
    expect(systemSearchHrefFromId('/(app)/agent-chat/sess-1/extra')).toBeNull();
    expect(systemSearchHrefFromId('/(app)/pr-review/../../settings')).toBeNull();
    expect(systemSearchHrefFromId('/(app)/pr-review/a/../b')).toBeNull();
    expect(
      systemSearchHrefFromId(
        '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/f-1/../f-2'
      )
    ).toBeNull();
    expect(
      systemSearchHrefFromId('/(app)/(tabs)/(3_profile)/security-agent/personal/nope/f-1')
    ).toBeNull();
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
