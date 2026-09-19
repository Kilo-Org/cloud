/* eslint-disable max-lines -- the collector suites for every source shape share one owned file */
/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock and the unused query function settle without await because they resolve immediately */
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RecentPrsModule from '@/lib/pr-review/recent-prs';
import { collectSystemSearchDocuments } from './system-search-collect';
import {
  planSystemSearchUpdate,
  providerInboxSourceScope,
  providerPrSearchDocument,
  recentPrSearchDocument,
  storedSessionSearchDocument,
} from './system-search-entries';

// The recents reader is the only storage read in the collector graph: the PR
// recents come from SecureStore, so it is mocked to a settable list. Every
// other document is built from the react-query cache below.
const recentPrs = vi.hoisted(() => ({
  getRecentPrs: vi.fn<() => Promise<RecentPrsModule.RecentPr[]>>(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('@/lib/pr-review/recent-prs', async importOriginal => {
  const actual = await importOriginal<typeof RecentPrsModule>();
  return { ...actual, getRecentPrs: recentPrs.getRecentPrs };
});

const SESSION_LIST_KEY = [
  ['cliSessionsV2', 'list'],
  { type: 'infinite', input: { organizationId: null } },
];
const ACTIVE_SESSIONS_KEY = [
  ['activeSessions', 'list'],
  { type: 'query', input: { organizationId: 'org-1', includeCloudAgentSessions: true } },
];
const INBOX_KEY = [['githubPrReview', 'listInbox'], { type: 'infinite', input: {} }];
const PROVIDER_INBOX_KEY = [
  ['providerReview', 'listInbox'],
  { type: 'infinite', input: { platform: 'gitlab' } },
];
const FINDINGS_KEY = [
  ['securityAgent', 'listFindings'],
  { type: 'infinite', input: { limit: 50, offset: 0 } },
];
const ORG_FINDINGS_KEY = [
  ['organizations', 'securityAgent', 'listFindings'],
  { type: 'infinite', input: { organizationId: 'org-1', limit: 50, offset: 0 } },
];
const UNRELATED_KEY = [['user', 'getMe'], { type: 'query' }];

// The stored recents list is read whole on every collect, so its per-provider
// scopes are observed alongside whatever the query cache enumerated.
const RECENTS_SOURCES = [
  'pullRequests:github:recents',
  'pullRequests:gitlab:recents',
  'pullRequests:bitbucket:recents',
];

const sessionRow = {
  session_id: 'sess-1',
  title: 'Fix login bug',
  organization_id: 'org-1',
  git_url: 'https://github.com/acme/api',
  git_branch: 'feature/live',
};

const storedSessions = {
  pages: [
    {
      cliSessions: [
        sessionRow,
        // Untitled: the app paints the translated "Untitled session" here.
        { session_id: 'sess-untitled', title: '   ', organization_id: null, git_branch: null },
        // Malformed: no id. It is skipped on its own, not with its page.
        { title: 'no id' },
      ],
      nextCursor: 'page-2',
    },
    // A later page repeating a session must not produce a second document.
    { cliSessions: [{ ...sessionRow, title: 'Fix login bug (stale page)' }], nextCursor: null },
  ],
};

const activeSessions = {
  sessions: [
    {
      id: 'live-1',
      title: 'Watch the deploy',
      organizationId: 'org-1',
      gitBranch: 'release',
    },
    // Malformed live row: no id.
    { title: 'no id either' },
  ],
};

const inbox = {
  pages: [
    {
      items: [{ owner: 'octocat', repo: 'hello-world', number: 42, title: 'Hello PR' }],
      nextCursor: null,
    },
  ],
};

const providerInbox = {
  pages: [
    {
      items: [
        {
          ref: {
            platform: 'gitlab',
            projectPath: 'group/sub/repo',
            mrIid: 12,
            instanceHint: 'https://gitlab.example.com',
          },
          title: 'Nested MR',
          author: null,
          state: 'open',
          draft: false,
          updatedAt: '2026-07-01T00:00:00Z',
        },
        {
          ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'web', prId: 7 },
          title: 'Bitbucket PR',
          author: null,
          state: 'open',
          draft: false,
          updatedAt: '2026-07-02T00:00:00Z',
        },
        // Malformed: no ref. The row alone is skipped, not its page.
        { title: 'no ref' },
        // A platform the app does not route is dropped like a malformed row.
        { ref: { platform: 'sourcehut', repo: 'r', number: 1 }, title: 'unknown platform' },
      ],
      nextCursor: null,
    },
  ],
};

const findings = {
  pages: [
    {
      findings: [
        {
          id: 'finding-1',
          title: 'SQL injection',
          severity: 'critical',
          repo_full_name: 'acme/api',
        },
        // Malformed finding row: no id.
        { title: 'no id at all' },
      ],
      totalCount: 1,
    },
  ],
};

const organizationFindings = {
  pages: [
    {
      findings: [{ id: 'finding-2', title: 'XSS', severity: 'high', repo_full_name: 'acme/web' }],
      totalCount: 1,
    },
  ],
};

function seed(client: QueryClient): void {
  client.setQueryData(SESSION_LIST_KEY, storedSessions);
  client.setQueryData(ACTIVE_SESSIONS_KEY, activeSessions);
  client.setQueryData(INBOX_KEY, inbox);
  client.setQueryData(FINDINGS_KEY, findings);
  client.setQueryData(ORG_FINDINGS_KEY, organizationFindings);
  client.setQueryData(UNRELATED_KEY, { id: 'user-1' });
}

function projection(document: {
  id: string;
  title: string;
  description: string;
  keywords: string[];
}) {
  return {
    id: document.id,
    title: document.title,
    description: document.description,
    keywords: document.keywords,
  };
}

describe('collectSystemSearchDocuments', () => {
  beforeEach(() => {
    recentPrs.getRecentPrs.mockReset();
    recentPrs.getRecentPrs.mockResolvedValue([]);
  });

  it('collects one document per cached entity, in cache order', async () => {
    const client = new QueryClient();
    seed(client);
    recentPrs.getRecentPrs.mockResolvedValue([
      // The same PR as the cached inbox row, with the title the authorized
      // load stored. The id is claimed once.
      {
        owner: 'octocat',
        repo: 'hello-world',
        number: 42,
        title: 'Hello PR',
        lastOpenedAt: 1,
      },
      // A recents-only PR the inbox never carried.
      { owner: 'acme', repo: 'api', number: 7, title: 'Recent PR', lastOpenedAt: 2 },
    ]);

    const { documents } = await collectSystemSearchDocuments(client);

    expect(documents.map(document => projection(document))).toEqual([
      {
        id: '/(app)/agent-chat/sess-1?organizationId=org-1',
        title: 'Fix login bug',
        description: 'feature/live',
        keywords: [],
      },
      {
        id: '/(app)/agent-chat/live-1?organizationId=org-1',
        title: 'Watch the deploy',
        description: 'release',
        keywords: [],
      },
      {
        id: '/(app)/pr-review/octocat/hello-world/42',
        title: 'Hello PR',
        description: 'octocat/hello-world#42',
        keywords: ['octocat/hello-world', '42'],
      },
      {
        id: '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1',
        title: 'SQL injection',
        description: 'acme/api · critical',
        keywords: ['acme/api', 'critical'],
      },
      {
        id: '/(app)/(tabs)/(3_profile)/security-agent/org-1/findings/finding-2',
        title: 'XSS',
        description: 'acme/web · high',
        keywords: ['acme/web', 'high'],
      },
      {
        id: '/(app)/pr-review/acme/api/7',
        title: 'Recent PR',
        description: 'acme/api#7',
        keywords: ['acme/api', '7'],
      },
    ]);
  });

  it('collects no documents from an empty cache', async () => {
    await expect(collectSystemSearchDocuments(new QueryClient())).resolves.toEqual({
      documents: [],
      observedSources: new Set(RECENTS_SOURCES),
    });
  });

  it('observes the recents scopes only when the stored list was read', async () => {
    recentPrs.getRecentPrs.mockRejectedValue(new Error('SecureStore unavailable'));

    const { observedSources } = await collectSystemSearchDocuments(new QueryClient());

    // A read that failed is not evidence the recents are empty, so no recents
    // scope is claimed and nothing is removed on its strength.
    expect(observedSources).toEqual(new Set());
  });

  it('lets a GitLab recents entry leave the index once the list drops it', async () => {
    const client = new QueryClient();
    // The stored list is empty now: the user removed the entry, or newer opens
    // evicted it. No inbox query can speak for a GitLab recents entry, so the
    // recents scope read above is the only evidence that may remove it.
    recentPrs.getRecentPrs.mockResolvedValue([]);
    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    const indexed = recentPrSearchDocument({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      title: 'Nested MR',
      platform: 'gitlab',
    });
    const plan = planSystemSearchUpdate({ indexed: [indexed], documents, observedSources });

    expect(plan.remove).toEqual([indexed.id]);
  });

  it('skips a malformed payload without throwing', async () => {
    const client = new QueryClient();
    client.setQueryData(SESSION_LIST_KEY, 'not a page list');
    client.setQueryData(INBOX_KEY, { items: [] });
    client.setQueryData(PROVIDER_INBOX_KEY, { items: [] });
    client.setQueryData(ORG_FINDINGS_KEY, { pages: [{ findings: [], totalCount: 0 }] });

    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    expect(documents).toEqual([]);
    // Only a payload that decodes as the family's list speaks for that family:
    // the empty-but-valid findings page is authoritative, while a payload of
    // the wrong shape is not evidence the family's entries are gone. The
    // recents scopes are observed either way, because that list was read.
    expect(observedSources).toEqual(new Set(['findings:org-1', ...RECENTS_SOURCES]));
  });

  it('does not claim a family from a bounded capacity probe', async () => {
    const client = new QueryClient();
    // The findings screen also mounts `useSecurityAnalysisCapacity`, which
    // fetches `listFindings` with `{ status: 'open', limit: 1 }` under the same
    // query path to read the concurrency counters. It is a successful
    // `listFindings` entry, but its finite payload enumerates no findings, so
    // it must not speak for the findings family.
    client.setQueryData(
      [
        ['securityAgent', 'listFindings'],
        { type: 'query', input: { status: 'open', limit: 1, offset: 0 } },
      ],
      {
        findings: [
          { id: 'finding-1', title: 'SQL injection', severity: 'critical', repo_full_name: 'a/b' },
        ],
        totalCount: 3,
        runningCount: 1,
        concurrencyLimit: 3,
      }
    );

    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    expect(documents).toEqual([]);
    expect(observedSources.has('findings:personal')).toBe(false);
  });

  it('does not claim the findings scope from a filtered list', async () => {
    const client = new QueryClient();
    // The findings screen's default view sends `status: 'open'`, and the
    // screen builds the key as `[...queryKey(), filters]`, so the filters ride
    // in the third segment. The query decodes as the list shape but enumerates
    // only the open findings: indexing its rows is right, speaking for the
    // whole personal scope would drop the fixed or dismissed entries it omits.
    client.setQueryData(
      [
        ['securityAgent', 'listFindings'],
        { type: 'query' },
        { status: 'open', sortBy: 'severity_desc', limit: 50, offset: 0 },
      ],
      findings
    );

    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    expect(documents.map(document => document.id)).toEqual([
      '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1',
    ]);
    expect(observedSources.has('findings:personal')).toBe(false);
  });

  it('claims the findings scope only from the unfiltered list', async () => {
    const client = new QueryClient();
    client.setQueryData(
      [
        ['securityAgent', 'listFindings'],
        { type: 'query' },
        { sortBy: 'severity_desc', limit: 50, offset: 0 },
      ],
      findings
    );

    const { observedSources } = await collectSystemSearchDocuments(client);

    expect(observedSources.has('findings:personal')).toBe(true);
  });

  it('does not claim the sessions scope from a narrowed list', async () => {
    const client = new QueryClient();
    // `createdOnPlatform` narrows the stored list to one platform's sessions,
    // so its success is not evidence that the other sessions are gone.
    client.setQueryData(
      [
        ['cliSessionsV2', 'list'],
        {
          type: 'infinite',
          input: {
            organizationId: null,
            limit: 30,
            orderBy: 'updated_at',
            createdOnPlatform: 'cli',
          },
        },
      ],
      storedSessions
    );

    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    expect(documents.map(document => document.id)).toEqual([
      '/(app)/agent-chat/sess-1?organizationId=org-1',
    ]);
    expect(observedSources.has('sessions:personal')).toBe(false);
  });

  it('does not claim a scope whose page window was trimmed by maxPages', async () => {
    const client = new QueryClient();
    const queryFn = vi.fn(async () => storedSessions);
    // The retained window is full (two pages against `maxPages: 2`), so the
    // oldest pages may already have been evicted: the query enumerates only
    // the pages it still holds.
    client.getQueryCache().build(client, { queryKey: SESSION_LIST_KEY, queryFn, maxPages: 2 });
    client.setQueryData(SESSION_LIST_KEY, storedSessions);

    const { observedSources } = await collectSystemSearchDocuments(client);

    expect(observedSources.has('sessions:personal')).toBe(false);
  });

  it('claims a source scope while its page window is below maxPages', async () => {
    const client = new QueryClient();
    const queryFn = vi.fn(async () => storedSessions);
    client.getQueryCache().build(client, { queryKey: SESSION_LIST_KEY, queryFn, maxPages: 20 });
    client.setQueryData(SESSION_LIST_KEY, storedSessions);

    const { observedSources } = await collectSystemSearchDocuments(client);

    expect(observedSources.has('sessions:personal')).toBe(true);
  });

  it('claims a pull-request provider only from its own inbox', async () => {
    const client = new QueryClient();
    client.setQueryData(INBOX_KEY, inbox);
    client.setQueryData(PROVIDER_INBOX_KEY, providerInbox);

    const { observedSources } = await collectSystemSearchDocuments(client);

    // The GitHub inbox is account-wide, so its source is the provider; the
    // GitLab inbox ran under the personal scope, so its source names that
    // scope as well.
    expect(observedSources.has('pullRequests:github')).toBe(true);
    expect(observedSources.has('pullRequests:gitlab:personal')).toBe(true);
    expect(observedSources.has('pullRequests:bitbucket:personal')).toBe(false);
  });

  it('does not claim a provider whose inbox input is not its default', async () => {
    const client = new QueryClient();
    // An input beyond the provider discriminator (and the optional
    // organization) is a filter, so the query enumerates a subset.
    client.setQueryData(
      [
        ['providerReview', 'listInbox'],
        { type: 'infinite', input: { platform: 'gitlab', state: 'open' } },
      ],
      providerInbox
    );

    const { observedSources } = await collectSystemSearchDocuments(client);

    expect(observedSources.has('pullRequests:gitlab:personal')).toBe(false);
  });

  it('keeps a provider source unobserved while a next page is still advertised', async () => {
    const client = new QueryClient();
    // A one-page window whose page advertises a next cursor holds only the
    // first page of the source. Its success is not evidence that the rows on
    // later pages are gone, so a refresh must not authorise removing them.
    client.setQueryData(SESSION_LIST_KEY, {
      pages: [{ cliSessions: [sessionRow], nextCursor: 'page-2' }],
    });
    client.setQueryData(INBOX_KEY, {
      pages: [
        {
          items: [{ owner: 'octocat', repo: 'hello-world', number: 42, title: 'Hello PR' }],
          nextCursor: 'page-2',
        },
      ],
    });
    client.setQueryData(PROVIDER_INBOX_KEY, {
      pages: [
        {
          items: [
            {
              ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 3 },
              title: 'First page MR',
            },
          ],
          nextCursor: 'page-2',
        },
      ],
    });
    client.setQueryData(FINDINGS_KEY, {
      pages: [
        {
          findings: [{ id: 'finding-1', title: 'SQL injection', severity: 'critical' }],
          totalCount: 5,
        },
      ],
    });

    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    // No query source is claimed; the recents scopes are, because that list was
    // read whole rather than left half-paginated.
    expect(observedSources).toEqual(new Set(RECENTS_SOURCES));

    // The index still holds a session indexed from a later page. The one-page
    // window is a prefix, so its success must not remove that entry.
    const laterPage = storedSessionSearchDocument({
      session_id: 'sess-later-page',
      title: 'Later page session',
      organization_id: null,
      git_branch: null,
    });
    expect(laterPage).not.toBeNull();
    if (laterPage !== null) {
      const plan = planSystemSearchUpdate({
        indexed: [laterPage],
        documents,
        observedSources,
      });
      expect(plan.remove).toEqual([]);
    }
  });

  it('claims a provider source once the cached pages reach the end', async () => {
    const client = new QueryClient();
    // The same rows with the terminal marker: the window now proves the source
    // was enumerated to its end, so a removal is authorised.
    client.setQueryData(SESSION_LIST_KEY, {
      pages: [{ cliSessions: [sessionRow], nextCursor: null }],
    });
    client.setQueryData(FINDINGS_KEY, {
      pages: [
        {
          findings: [{ id: 'finding-1', title: 'SQL injection', severity: 'critical' }],
          totalCount: 1,
        },
      ],
    });

    const { observedSources } = await collectSystemSearchDocuments(client);

    expect(observedSources.has('sessions:personal')).toBe(true);
    expect(observedSources.has('findings:personal')).toBe(true);
  });

  it('keeps another organization’s pull requests when one organization’s inbox is authoritative', async () => {
    const client = new QueryClient();
    // The active organization's GitLab inbox enumerated to its end.
    const organizationA = { platform: 'gitlab' as const, projectPath: 'acme/api', mrIid: 7 };
    client.setQueryData(
      [
        ['providerReview', 'listInbox'],
        { type: 'infinite', input: { platform: 'gitlab', organizationId: 'org-a' } },
      ],
      { pages: [{ items: [{ ref: organizationA, title: 'A MR' }], nextCursor: null }] }
    );

    const { documents, observedSources } = await collectSystemSearchDocuments(client);

    // The index still holds an MR enumerated under a different organization.
    const organizationB = { platform: 'gitlab' as const, projectPath: 'beta/tools', mrIid: 9 };
    const otherOrganization = providerPrSearchDocument(
      organizationB,
      'B MR',
      providerInboxSourceScope('gitlab', 'org-b')
    );
    // And one of org A's own that the inbox no longer carries.
    const sameOrganization = providerPrSearchDocument(
      { platform: 'gitlab' as const, projectPath: 'acme/api', mrIid: 8 },
      'A MR (removed from the inbox)',
      providerInboxSourceScope('gitlab', 'org-a')
    );

    const plan = planSystemSearchUpdate({
      indexed: [otherOrganization, sameOrganization],
      documents,
      observedSources,
    });

    // Org A's own stale row leaves; org B's row is not this scope's to remove.
    expect(plan.remove).toEqual([sameOrganization.id]);
  });

  it('does not claim a family whose source query never produced data', async () => {
    const client = new QueryClient();
    const queryFn = vi.fn(async () => ({ pages: [{ findings: [] }] }));
    // A query that is present but never resolved carries no evidence: its data
    // is undefined, so the findings family stays unobserved and stale findings
    // are kept rather than dropped.
    client.getQueryCache().build(client, { queryKey: FINDINGS_KEY, queryFn });

    const { observedSources } = await collectSystemSearchDocuments(client);

    expect(observedSources.has('findings:personal')).toBe(false);
  });

  it('indexes the GitLab and Bitbucket rows the provider inbox cache holds', async () => {
    const client = new QueryClient();
    client.setQueryData(PROVIDER_INBOX_KEY, providerInbox);
    // The same GitLab MR also sits in the stored recents: the collector
    // dedupes by id, so the index carries one entry per PR, not two.
    recentPrs.getRecentPrs.mockResolvedValue([
      {
        owner: 'group/sub',
        repo: 'repo',
        number: 12,
        title: 'Nested MR',
        platform: 'gitlab',
        instanceHint: 'https://gitlab.example.com',
        lastOpenedAt: 1,
      },
    ]);

    const { documents } = await collectSystemSearchDocuments(client);

    expect(documents.map(document => projection(document))).toEqual([
      {
        id: '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com',
        title: 'Nested MR',
        description: 'group/sub/repo!12',
        keywords: ['group/sub/repo', '12'],
      },
      {
        id: '/(app)/pr-review/bitbucket/acme/web/7',
        title: 'Bitbucket PR',
        description: 'acme/web#7',
        keywords: ['acme/web', '7'],
      },
    ]);
  });

  it('reads the cache without invoking any query function', async () => {
    const queryFn = vi.fn(async () => ({ pages: [] }));
    const client = new QueryClient();
    client.getQueryCache().build(client, { queryKey: SESSION_LIST_KEY, queryFn });
    client.setQueryData(SESSION_LIST_KEY, storedSessions);

    const { documents } = await collectSystemSearchDocuments(client);

    expect(documents.map(document => document.id)).toEqual([
      '/(app)/agent-chat/sess-1?organizationId=org-1',
    ]);
    expect(queryFn).not.toHaveBeenCalled();
  });
});
