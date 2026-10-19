// s6 (identity rule 17): the viewed-files hook is provider-scoped end to
// end. The store folds `providerPrRefKey` into the durable key only when it
// receives the ref, so a GitLab MR and a same-numbered GitHub PR — or one
// project on two GitLab instances — never share a viewed set. These tests
// exercise the hook's mounted behavior; the store's keying itself is covered
// in `viewed-files.test.ts`.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePrReviewViewedFiles } from '@/lib/pr-review/diff/pr-review-file-list-state';
import { resetViewedFilesStoreForTests } from '@/lib/pr-review/diff/viewed-files-store';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      listFiles: {
        infiniteQueryOptions: () => ({}),
      },
    },
  }),
}));

const storeMocks = vi.hoisted(() => ({
  getViewedFiles: vi.fn(),
  toggleViewedFile: vi.fn(),
}));

// Only the durable I/O layer is faked; `viewedFilesKey` stays the real
// provider-scoped implementation so the tests exercise the identity rule the
// hook exists for. The real `viewed-files` module loads fine in this node
// environment once its SecureStore chain is stubbed.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => {
    await Promise.resolve();
    return null;
  }),
  setItemAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
  deleteItemAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

vi.mock('@/lib/storage-keys', () => ({
  PR_REVIEW_VIEWED_KEY: 'pr-review-viewed',
}));

vi.mock('@/lib/pr-review/viewed-files', async importOriginal => {
  const actual = await importOriginal<{
    getViewedFiles: unknown;
    toggleViewedFile: unknown;
    viewedFilesKey: unknown;
  }>();
  return {
    ...actual,
    getViewedFiles: storeMocks.getViewedFiles,
    toggleViewedFile: storeMocks.toggleViewedFile,
  };
});

// The two fixtures share the legacy `owner/repo#number` triple: only the
// provider-scoped key suffix (`providerPrRefKey`) separates their viewed
// sets, so a real key that dropped the suffix would fail this suite.
const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'octocat/hello-world',
  mrIid: 12,
  instanceHint: 'https://gitlab.example.com',
};

const GITHUB_REF_SAME_NUMBER: ProviderPrRef = {
  platform: 'github',
  owner: 'octocat',
  repo: 'hello-world',
  number: 12,
};

type ViewedRefArg = Parameters<typeof usePrReviewViewedFiles>[0];

type ProbeResult = {
  isViewed: (path: string) => boolean;
  toggle: (path: string) => Promise<void>;
};

type ProbeHolder = { current: ProbeResult | null };

function Probe({ viewRef, holder }: { viewRef: ViewedRefArg; holder: ProbeHolder }) {
  holder.current = usePrReviewViewedFiles(viewRef, 'sha-1');
  return null;
}

async function mountProbeHolder(viewRef: ViewedRefArg): Promise<ProbeHolder> {
  const holder: ProbeHolder = { current: null };
  await renderWithProviders(createElement(Probe, { viewRef, holder }));
  await act(async () => {
    await Promise.resolve();
  });
  return holder;
}

function viewedOf(holder: ProbeHolder): ProbeResult {
  if (!holder.current) {
    throw new Error('probe did not render');
  }
  return holder.current;
}

beforeEach(() => {
  // The mounted renderers are not unmounted between tests, so drop the store's
  // subscriptions to make each test start from a fresh read.
  resetViewedFilesStoreForTests();
  storeMocks.getViewedFiles.mockReset().mockResolvedValue([] as string[]);
  storeMocks.toggleViewedFile.mockReset().mockResolvedValue(undefined);
});

describe('usePrReviewViewedFiles provider refs (s6)', () => {
  it('keeps two provider identities independent through the same mount flow', async () => {
    // Same number, different providers: the store keys by provider identity,
    // so a toggle on the GitLab MR never lights up the GitHub PR. The fake
    // durable layer records per-key sets so the post-write revalidation sees
    // exactly what the optimistic publish showed.
    const durable: Record<string, string[]> = {};
    storeMocks.getViewedFiles.mockImplementation(async (ref: unknown) => {
      await Promise.resolve();
      return [...(durable[JSON.stringify(ref)] ?? [])];
    });
    storeMocks.toggleViewedFile.mockImplementation(
      async (input: { path: string; headSha: string } & Record<string, unknown>) => {
        await Promise.resolve();
        // getViewedFiles is called as (ref, headSha); the durable record key
        // is the ref alone, so the toggle input's headSha drops out too.
        const { path, headSha: _headSha, ...ref } = input;
        const key = JSON.stringify(ref);
        const current = durable[key] ?? [];
        durable[key] = current.includes(path)
          ? current.filter(p => p !== path)
          : [...current, path];
      }
    );

    const gitlab = await mountProbeHolder(GITLAB_REF);
    const github = await mountProbeHolder(GITHUB_REF_SAME_NUMBER);

    // One durable read per distinct key: each identity read its own set.
    expect(storeMocks.getViewedFiles).toHaveBeenCalledTimes(2);

    await act(async () => {
      await viewedOf(gitlab).toggle('src/a.ts');
    });

    // The GitLab probe shows the toggle; the GitHub probe does not.
    await waitFor(() => viewedOf(gitlab).isViewed('src/a.ts'));
    expect(viewedOf(github).isViewed('src/a.ts')).toBe(false);
  });

  it('shares one read and one toggle across two mounted probes', async () => {
    // A durable set the write actually updates, so the post-toggle revalidation
    // publishes the same state the optimistic publish showed.
    const durable: string[] = ['src/a.ts'];
    storeMocks.getViewedFiles.mockImplementation(async () => {
      await Promise.resolve();
      return [...durable];
    });
    storeMocks.toggleViewedFile.mockImplementation(async (input: { path: string }) => {
      await Promise.resolve();
      const index = durable.indexOf(input.path);
      if (index === -1) {
        durable.push(input.path);
      } else {
        durable.splice(index, 1);
      }
    });

    const first = await mountProbeHolder(GITLAB_REF);
    const second = await mountProbeHolder(GITLAB_REF);

    // One store entry per key: the second mount joins the first read.
    expect(storeMocks.getViewedFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => viewedOf(first).isViewed('src/a.ts'));
    await waitFor(() => viewedOf(second).isViewed('src/a.ts'));

    await act(async () => {
      await viewedOf(first).toggle('src/b.ts');
    });

    expect(storeMocks.toggleViewedFile).toHaveBeenCalledTimes(1);
    await waitFor(() => viewedOf(first).isViewed('src/b.ts'));
    await waitFor(() => viewedOf(second).isViewed('src/b.ts'));
  });
});
