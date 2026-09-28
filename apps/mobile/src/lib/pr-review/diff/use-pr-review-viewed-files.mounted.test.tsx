// s6 (identity rule 17): the viewed-files hook is provider-scoped end to
// end. The store folds `providerPrRefKey` into the durable key only when it
// receives the ref, so a GitLab MR and a same-numbered GitHub PR — or one
// project on two GitLab instances — never share a viewed set. These tests
// pin the hook's pass-through; the store's keying itself is covered in
// `viewed-files.test.ts`.

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
  // The real key is the provider-scoped identity (rule 17); the store only
  // needs it to be stable per ref, so the stub stringifies the ref.
  viewedFilesKey: vi.fn((ref: unknown) => JSON.stringify(ref)),
}));

vi.mock('@/lib/pr-review/viewed-files', () => storeMocks);

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
  instanceHint: 'https://gitlab.example.com',
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

async function mountProbe(viewRef: ViewedRefArg) {
  return viewedOf(await mountProbeHolder(viewRef));
}

beforeEach(() => {
  // The mounted renderers are not unmounted between tests, so drop the store's
  // subscriptions to make each test start from a fresh read.
  resetViewedFilesStoreForTests();
  storeMocks.getViewedFiles.mockReset().mockResolvedValue([] as string[]);
  storeMocks.toggleViewedFile.mockReset().mockResolvedValue(undefined);
});

describe('usePrReviewViewedFiles provider refs (s6)', () => {
  it('reads the viewed set under the provider ref, not the bare triple', async () => {
    await mountProbe(GITLAB_REF);
    expect(storeMocks.getViewedFiles).toHaveBeenCalledWith(GITLAB_REF, 'sha-1');
  });

  it('writes the toggle under the provider ref, folding the key identity', async () => {
    const viewed = await mountProbe(GITLAB_REF);
    await act(async () => {
      await viewed.toggle('src/a.ts');
    });
    expect(storeMocks.toggleViewedFile).toHaveBeenCalledWith({
      ...GITLAB_REF,
      headSha: 'sha-1',
      path: 'src/a.ts',
    });
  });

  it('keeps the legacy GitHub triple working byte-for-byte', async () => {
    const legacy = { owner: 'octocat', repo: 'hello-world', number: 7 };
    await mountProbe(legacy);
    expect(storeMocks.getViewedFiles).toHaveBeenCalledWith(legacy, 'sha-1');
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
