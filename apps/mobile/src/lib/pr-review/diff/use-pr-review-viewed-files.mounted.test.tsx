/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as use-fetch-to-completion.mounted.test.tsx) */
// s6 (identity rule 17): the viewed-files hook is provider-scoped end to
// end. The store folds `providerPrRefKey` into the durable key only when it
// receives the ref, so a GitLab MR and a same-numbered GitHub PR — or one
// project on two GitLab instances — never share a viewed set. These tests
// pin the hook's pass-through; the store's keying itself is covered in
// `viewed-files.test.ts`.

import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePrReviewViewedFiles } from '@/lib/pr-review/diff/pr-review-file-list-state';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { renderWithProviders } from '@/test/render-with-providers';

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

vi.mock('@/lib/pr-review/viewed-files', () => storeMocks);

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
  instanceHint: 'https://gitlab.example.com',
};

type ViewedRefArg = Parameters<typeof usePrReviewViewedFiles>[0];

type ProbeHolder = {
  current: { isViewed: (path: string) => boolean; toggle: (path: string) => Promise<void> } | null;
};

function Probe({ viewRef, holder }: { viewRef: ViewedRefArg; holder: ProbeHolder }) {
  holder.current = usePrReviewViewedFiles(viewRef, 'sha-1');
  return null;
}

async function mountProbe(viewRef: ViewedRefArg) {
  const holder: ProbeHolder = { current: null };
  await renderWithProviders(createElement(Probe, { viewRef, holder }));
  await act(async () => {
    await Promise.resolve();
  });
  if (!holder.current) {
    throw new Error('probe did not render');
  }
  return holder.current;
}

beforeEach(() => {
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
});
