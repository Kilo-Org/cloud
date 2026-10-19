import { createElement } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type PrReviewFileListQueryResult,
  usePrReviewFileListQuery,
} from '@/lib/pr-review/diff/pr-review-file-list-state';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── Mocks ──────────────────────────────────────────────────────────────────

const queryFnMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      listFiles: {
        infiniteQueryOptions: (input: unknown, opts: object) => ({
          ...opts,
          queryKey: ['githubPrReview', 'listFiles', input],
          queryFn: queryFnMock,
          initialPageParam: undefined as string | undefined,
          getNextPageParam: (lastPage: { nextCursor: string | null }) =>
            lastPage.nextCursor ?? undefined,
        }),
      },
    },
  }),
}));

// The hook's import chain pulls the real viewed-files store (SecureStore);
// the store is not the subject here, so it is stubbed like the other mounted
// suites for this module do.
vi.mock('@/lib/pr-review/viewed-files', () => ({
  getViewedFiles: vi.fn(async () => {
    await Promise.resolve();
    return [] as string[];
  }),
  toggleViewedFile: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

// ── Harness ────────────────────────────────────────────────────────────────

type Result = PrReviewFileListQueryResult;

function Probe({ holder }: { holder: { current: Result | null } }) {
  holder.current = usePrReviewFileListQuery({ owner: 'octocat', repo: 'hello', number: 1, enabled: true });
  return null;
}

async function mountProbe() {
  const holder: { current: Result | null } = { current: null };
  await renderWithProviders(createElement(Probe, { holder }));
  return holder;
}

function current(holder: { current: Result | null }): Result {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

const FILE_A = { path: 'a.ts' };
const FILE_B = { path: 'b.ts' };

beforeEach(() => {
  queryFnMock.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('usePrReviewFileListQuery error classification', () => {
  it('a first-page failure surfaces firstPageErrorState and no laterPageError', async () => {
    queryFnMock.mockRejectedValue(new Error('network down'));
    const holder = await mountProbe();

    await waitFor(() => current(holder).errorState !== null);

    const result = current(holder);
    expect(result.errorState?.kind).toBe('retryable');
    expect(result.firstPageErrorState?.kind).toBe('retryable');
    expect(result.laterPageError).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('a NOT_FOUND first page classifies as not-found', async () => {
    queryFnMock.mockRejectedValue({ data: { code: 'NOT_FOUND' } });
    const holder = await mountProbe();

    await waitFor(() => current(holder).errorState !== null);

    const result = current(holder);
    expect(result.errorState?.kind).toBe('not-found');
    expect(result.firstPageErrorState?.kind).toBe('not-found');
    expect(result.laterPageError).toBe(false);
  });

  it('a later-page failure keeps the loaded files and flips laterPageError', async () => {
    queryFnMock
      .mockResolvedValueOnce({ files: [FILE_A], nextCursor: 'cursor-2' })
      .mockRejectedValueOnce(new Error('page 2 failed'));
    const holder = await mountProbe();

    // Load page one, then let the hook auto-run fetch-to-completion? No: the
    // hook itself only reads; drive page two through the query handle it
    // exposes.
    await waitFor(() => current(holder).files.length === 1);
    expect(current(holder).files).toEqual([FILE_A]);

    await act(async () => {
      await current(holder).query.fetchNextPage();
    });
    await waitFor(() => current(holder).errorState !== null);

    const result = current(holder);
    expect(result.errorState?.kind).toBe('retryable');
    // A page-1 set survived: the tab must not blank on a later-page failure.
    expect(result.firstPageErrorState).toBeNull();
    expect(result.laterPageError).toBe(true);
    expect(result.files).toEqual([FILE_A]);
    expect(queryFnMock).toHaveBeenCalledTimes(2);
  });

  it('loads pages through the provider page shape (sanity on the option wiring)', async () => {
    queryFnMock
      .mockResolvedValueOnce({ files: [FILE_A], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ files: [FILE_B], nextCursor: null });
    const holder = await mountProbe();

    await act(async () => {
      await current(holder).query.fetchNextPage();
    });

    await waitFor(() => current(holder).files.length === 2);
    expect(current(holder).files).toEqual([FILE_A, FILE_B]);
    expect(current(holder).errorState).toBeNull();
    expect(current(holder).firstPageErrorState).toBeNull();
    expect(current(holder).laterPageError).toBe(false);
  });
});
