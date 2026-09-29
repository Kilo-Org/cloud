import { createElement } from 'react';
import { act } from '@/test/renderer';
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

const TWENTY = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

const ITEM: ExpandSeparatorItem = {
  kind: 'expand-separator',
  key: 'expand:0',
  filePath: 'src/index.ts',
  ref: { owner: 'octocat', repo: 'hello-world', number: 1, ref: 'sha' },
  context: { gapIndex: 0, startLine: 10, endLine: 50 },
  state: 'idle',
};

function item(startLine: number, endLine: number): ExpandSeparatorItem {
  return { ...ITEM, key: 'expand:0', context: { gapIndex: 0, startLine, endLine } };
}

// A gap whose second window is clamped by the gap end rather than the
// window size, so the clamped end proves the fetch starts at the advanced
// separator line instead of a line advanced twice.
async function secondWindow(first: ExpandSeparatorItem, second: ExpandSeparatorItem) {
  const holder = await mountProbe();
  act(() => {
    current(holder).handleLoadContext(first, 20);
  });
  await waitFor(() => current(holder).expandedContext['src/index.ts']?.[0]?.status === 'partial');
  act(() => {
    current(holder).handleLoadContext(second, 20);
  });
  await waitFor(() => queryFnMock.mock.calls.length === 2);
  const call = queryFnMock.mock.calls[1]?.[0] as {
    queryKey: [string, string, { startLine: number; endLine: number }];
  };
  return call.queryKey[2];
}

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

  it('fetches the second expansion from the advanced separator start line, not past the gap end', async () => {
    // A gap whose total size (26 lines) is smaller than two windows. The
    // separator that `pushGapItems` rebuilds after window 1 already points at
    // line 30 (`startLine` 10 + 20 loaded); the loader must fetch from there,
    // not add the loaded count a second time (which would send startLine 50 >
    // endLine 35 and strand the user on a failing retry).
    queryFnMock.mockResolvedValue({ lines: TWENTY, totalLines: 100 });
    const context = await secondWindow(item(10, 35), item(30, 35));
    expect(context).toMatchObject({ startLine: 30, endLine: 35 });
  });

  it('continues the second expansion at the separator start line without skipping a window', async () => {
    // A gap larger than one window (51 lines). Window 2 must start at line 30
    // and run a full window to line 49; adding the already-loaded count again
    // would start at line 50 and silently drop lines 30-49.
    queryFnMock.mockResolvedValue({ lines: TWENTY, totalLines: 100 });
    const context = await secondWindow(item(10, 60), item(30, 60));
    expect(context).toMatchObject({ startLine: 30, endLine: 49 });
  });
});
