/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ExpandSeparatorItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { usePrDiffContextLoader } from '@/lib/pr-review/diff/use-pr-diff-context-loader';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const queryFnMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      getFileLines: {
        queryOptions: (input: unknown, opts: object) => ({
          ...opts,
          queryKey: ['githubPrReview', 'getFileLines', input],
          queryFn: queryFnMock,
        }),
      },
    },
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

type LoaderResult = ReturnType<typeof usePrDiffContextLoader>;

function Probe({ holder }: { holder: { current: LoaderResult | null } }) {
  const result = usePrDiffContextLoader({ owner: 'octocat', repo: 'hello-world', headSha: 'sha' });
  holder.current = result;
  return null;
}

async function mountProbe(): Promise<{ current: LoaderResult | null }> {
  const holder: { current: LoaderResult | null } = { current: null };
  await renderWithProviders(createElement(Probe, { holder }));
  return holder;
}

function current(holder: { current: LoaderResult | null }): LoaderResult {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

const ITEM: ExpandSeparatorItem = {
  kind: 'expand-separator',
  key: 'expand:0',
  filePath: 'src/index.ts',
  ref: { owner: 'octocat', repo: 'hello-world', number: 1, ref: 'sha' },
  context: { gapIndex: 0, startLine: 10, endLine: 50 },
  state: 'idle',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('usePrDiffContextLoader', () => {
  beforeEach(() => {
    queryFnMock.mockReset();
    queryFnMock.mockResolvedValue({ lines: ['line-a'], totalLines: 1 });
  });

  it('re-expanding the same gap is a react-query cache hit (queryFn runs once)', async () => {
    const holder = await mountProbe();

    act(() => {
      current(holder).handleLoadContext(ITEM, 20);
      current(holder).handleLoadContext(ITEM, 20);
    });

    await waitFor(() => current(holder).expandedContext['src/index.ts']?.[0]?.status === 'partial');
    expect(queryFnMock).toHaveBeenCalledTimes(1);
  });
});
