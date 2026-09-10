/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { type QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { useProviderInbox } from './use-provider-inbox';

// The hook module reaches the tRPC client, the organization context and the
// connection-status hooks; the trpc stub hands every query a controlled fn so
// a test can prove WHICH endpoints the merged inbox actually calls.
const githubAuth = vi.hoisted(() => vi.fn<(ctx: { pageParam?: unknown }) => Promise<unknown>>());
const githubInbox = vi.hoisted(() => vi.fn<(ctx: { pageParam?: unknown }) => Promise<unknown>>());
const providerInbox = vi.hoisted(() => vi.fn<(ctx: { pageParam?: unknown }) => Promise<unknown>>());

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: {
        queryOptions: () => ({ queryKey: ['test', 'github-auth'], queryFn: githubAuth }),
      },
    },
    githubPrReview: {
      listInbox: {
        infiniteQueryOptions: (_input: unknown, opts: object) => ({
          queryKey: ['test', 'github-inbox'],
          queryFn: githubInbox,
          ...opts,
        }),
      },
    },
    providerReview: {
      listInbox: {
        infiniteQueryOptions: (input: unknown, opts: object) => ({
          queryKey: ['test', 'provider-inbox', input],
          queryFn: providerInbox,
          ...opts,
        }),
      },
    },
  }),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));

// The two provider statuses are ordinary hooks elsewhere; here they are the
// test's control panel for "connected" / "not connected" / "still resolving".
// `isPending` is what the merge reads to keep a source active-as-pending, so
// every fixture sets it explicitly.
const statuses = vi.hoisted(() => ({
  gitlab: { data: undefined as { connected: boolean } | undefined, isPending: true },
  bitbucket: { data: undefined as { connected: boolean } | undefined, isPending: true },
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useGitLabStatus: () => statuses.gitlab,
  useBitbucketReadiness: () => statuses.bitbucket,
}));

type ProviderInbox = ReturnType<typeof useProviderInbox>;

let captured: ProviderInbox | undefined = undefined;

function Harness() {
  captured = useProviderInbox(true);
  return null;
}

const githubPage = {
  items: [
    {
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      title: 'GitHub PR',
      isDraft: false,
      updatedAt: '2026-01-02T00:00:00Z',
    },
  ],
  nextCursor: null,
};

const gitlabPage = {
  items: [
    {
      ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
      title: 'GitLab MR',
      author: null,
      state: 'open',
      draft: false,
      updatedAt: '2026-01-03T00:00:00Z',
    },
  ],
  nextCursor: null,
};

async function mountInbox() {
  const mounted = await renderWithProviders(createElement(Harness));
  inboxClient = mounted.queryClient;
  return mounted.unmount;
}

/** The cache of the last mounted inbox, so a test can watch a query settle. */
let inboxClient: QueryClient | undefined = undefined;

/** Flush one macrotask inside act so queued re-renders are applied. */
async function flush() {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  captured = undefined;
  inboxClient = undefined;
  githubAuth.mockReset();
  githubInbox.mockReset();
  providerInbox.mockReset();
  githubInbox.mockResolvedValue(githubPage);
  providerInbox.mockResolvedValue(gitlabPage);
  statuses.gitlab = { data: undefined, isPending: true };
  statuses.bitbucket = { data: undefined, isPending: true };
});

describe('useProviderInbox connection gating', () => {
  it('never queries the GitHub inbox for a user with no GitHub connection', async () => {
    // The entry screen's connect gate is a pass-through, so a GitLab-only
    // user reaches the merged inbox. The GitHub source must stay disabled:
    // `githubPrReview.listInbox` answers PRECONDITION_FAILED for them, which
    // used to surface as a permanent "couldn't load more" retry under a
    // perfectly healthy GitLab list.
    githubAuth.mockResolvedValue({ connected: false });
    statuses.gitlab = { data: { connected: true }, isPending: false };
    const unmount = await mountInbox();

    await waitFor(() => (captured?.items.length ?? 0) === 1);

    expect(githubInbox).not.toHaveBeenCalled();
    expect(providerInbox).toHaveBeenCalled();
    expect(captured?.items.map(row => row.title)).toEqual(['GitLab MR']);
    expect(captured?.laterPageError).toBe(false);
    expect(captured?.firstPageErrorState).toBeNull();
    unmount();
  });

  it('keeps the skeletons while the connection statuses are still resolving', async () => {
    // Every status pending means every source is "enabled but pending": the
    // merge must report pending, never the "No review requests" empty state,
    // which would flash before the statuses settle.
    githubAuth.mockReturnValue(new Promise(() => undefined));
    const unmount = await mountInbox();
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });

    expect(githubInbox).not.toHaveBeenCalled();
    expect(captured?.items).toEqual([]);
    expect(captured?.isPending).toBe(true);
    unmount();
  });

  it('fires the GitHub inbox once the authorization reports connected', async () => {
    githubAuth.mockResolvedValue({ connected: true });
    const unmount = await mountInbox();

    await waitFor(() => (captured?.items.length ?? 0) === 1);

    expect(githubAuth).toHaveBeenCalled();
    expect(githubInbox).toHaveBeenCalled();
    expect(captured?.items.map(row => row.title)).toEqual(['GitHub PR']);
    expect(captured?.laterPageError).toBe(false);
    unmount();
  });

  it('never calls the GitHub inbox from the retries while unconnected', async () => {
    githubAuth.mockResolvedValue({ connected: false });
    statuses.gitlab = { data: { connected: true }, isPending: false };
    const unmount = await mountInbox();
    await waitFor(() => (captured?.items.length ?? 0) === 1);

    // `refetch()` bypasses `enabled`, so both retry paths must check the
    // connection gate themselves.
    act(() => {
      captured?.refetch();
      captured?.retryFailedPages();
    });
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });

    expect(githubInbox).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the reconnect view when a connected GitHub token fails its first page', async () => {
    // A user who WAS connected keeps the reconnect affordance: the status
    // query answered connected, the inbox then failed with the stale-token
    // error, and with no other provider enabled that failure is the whole
    // list's first-page state.
    githubAuth.mockResolvedValue({ connected: true });
    // The other statuses must ANSWER disconnected: a still-resolving status
    // keeps its source active-as-pending, and then the merge may not blank
    // the list (covered by the race test below).
    statuses.gitlab = { data: { connected: false }, isPending: false };
    statuses.bitbucket = { data: { connected: false }, isPending: false };
    // Shaped the way a tRPC client error reaches the hook (`data.code`).
    githubInbox.mockRejectedValue({ data: { code: 'PRECONDITION_FAILED' } });
    const unmount = await mountInbox();

    await waitFor(() => captured?.firstPageErrorState !== null && captured !== undefined);

    expect(captured?.firstPageErrorState).toEqual({ kind: 'reconnect' });
    unmount();
  });

  it('keeps the skeletons when GitHub answers disconnected while GitLab is still resolving', async () => {
    // The false-empty-state race: the GitHub status settles `connected:
    // false` first, so the GitHub source leaves the merge. The GitLab rows
    // can only arrive after the GitLab status resolves, so until then the
    // GitLab source must stay active-as-pending — otherwise the merge sees
    // no active source, reports settled, and the "No review requests" empty
    // state flashes before the GitLab list loads.
    githubAuth.mockResolvedValue({ connected: false });
    const unmount = await mountInbox();

    // Gate on the cache so the assertion below cannot pass while the
    // GitHub status is still pending: wait until the status query has
    // SUCCEEDED (answered `connected: false`) and that render landed.
    await waitFor(() => inboxClient?.getQueryState(['test', 'github-auth'])?.status === 'success');
    await flush();

    expect(captured?.items).toEqual([]);
    expect(captured?.isPending).toBe(true);
    expect(captured?.firstPageErrorState).toBeNull();
    unmount();
  });

  it('surfaces a failed GitHub connection status as a retryable error, not the empty state', async () => {
    // A status query that FAILS leaves the connection UNKNOWN, not
    // "disconnected": the source must contribute the error so the merge
    // renders the retryable first-page failure, and the retry must reload
    // the status query itself — never the inbox query it gates.
    githubAuth.mockRejectedValue(new Error('network down'));
    statuses.gitlab = { data: { connected: false }, isPending: false };
    const unmount = await mountInbox();

    await waitFor(() => captured?.firstPageErrorState !== null && captured !== undefined);

    expect(captured?.firstPageErrorState).toEqual({ kind: 'retryable' });
    expect(captured?.isPending).toBe(false);
    expect(githubInbox).not.toHaveBeenCalled();

    const statusCalls = githubAuth.mock.calls.length;
    act(() => {
      captured?.refetch();
      captured?.retryFailedPages();
    });
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });

    expect(githubAuth.mock.calls.length).toBeGreaterThan(statusCalls);
    // The gated inbox query stays untouched: the retry went through the
    // status, which is the only query that can recover from this state.
    expect(githubInbox).not.toHaveBeenCalled();
    unmount();
  });

  it('reaches the empty state in personal scope once every status answered', async () => {
    // Bitbucket's readiness query is permanently disabled in personal scope
    // (org-only), so its pending must not hold the merge open: a user
    // connected to nothing must see "No review requests", never skeletons
    // that never lift.
    githubAuth.mockResolvedValue({ connected: false });
    statuses.gitlab = { data: { connected: false }, isPending: false };
    const unmount = await mountInbox();

    // Gate on the cache so the assertion cannot race the status settling.
    await waitFor(() => inboxClient?.getQueryState(['test', 'github-auth'])?.status === 'success');
    await flush();

    expect(captured?.isPending).toBe(false);
    expect(captured?.items).toEqual([]);
    expect(captured?.firstPageErrorState).toBeNull();
    unmount();
  });
});
