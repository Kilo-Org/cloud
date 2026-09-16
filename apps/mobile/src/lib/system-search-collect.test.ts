/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock and the unused query function settle without await because they resolve immediately */
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RecentPrsModule from '@/lib/pr-review/recent-prs';
import { collectSystemSearchDocuments } from './system-search-collect';

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
const FINDINGS_KEY = [
  ['securityAgent', 'listFindings'],
  { type: 'infinite', input: { limit: 50, offset: 0 } },
];
const ORG_FINDINGS_KEY = [
  ['organizations', 'securityAgent', 'listFindings'],
  { type: 'infinite', input: { organizationId: 'org-1', limit: 50, offset: 0 } },
];
const UNRELATED_KEY = [['user', 'getMe'], { type: 'query' }];

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
    },
    // A later page repeating a session must not produce a second document.
    { cliSessions: [{ ...sessionRow, title: 'Fix login bug (stale page)' }] },
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
  pages: [{ items: [{ owner: 'octocat', repo: 'hello-world', number: 42, title: 'Hello PR' }] }],
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
    },
  ],
};

const organizationFindings = {
  pages: [
    { findings: [{ id: 'finding-2', title: 'XSS', severity: 'high', repo_full_name: 'acme/web' }] },
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

    const documents = await collectSystemSearchDocuments(client);

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

  it('collects nothing from an empty cache', async () => {
    await expect(collectSystemSearchDocuments(new QueryClient())).resolves.toEqual([]);
  });

  it('skips a malformed payload without throwing', async () => {
    const client = new QueryClient();
    client.setQueryData(SESSION_LIST_KEY, 'not a page list');
    client.setQueryData(INBOX_KEY, { items: [] });
    client.setQueryData(ORG_FINDINGS_KEY, { pages: [{ findings: [] }] });

    await expect(collectSystemSearchDocuments(client)).resolves.toEqual([]);
  });

  it('reads the cache without invoking any query function', async () => {
    const queryFn = vi.fn(async () => ({ pages: [] }));
    const client = new QueryClient();
    client.getQueryCache().build(client, { queryKey: SESSION_LIST_KEY, queryFn });
    client.setQueryData(SESSION_LIST_KEY, storedSessions);

    const documents = await collectSystemSearchDocuments(client);

    expect(documents.map(document => document.id)).toEqual([
      '/(app)/agent-chat/sess-1?organizationId=org-1',
    ]);
    expect(queryFn).not.toHaveBeenCalled();
  });
});
