// `useDiffRenderItem` binds one identity-stable `onTap` per rendered diff line,
// so `DiffLine`'s memo comparator — which compares `onTap` by reference
// (`diff-line.tsx`) — can hit. A fresh closure per line per render defeated it,
// so tapping one line re-rendered every mounted diff row instead of only the
// rows whose `isSelected` changed. These tests pin the three behaviours that
// make the memo hit:
//   (a) the element's `onTap` prop keeps the same reference across a re-render
//       that only changes `selection`;
//   (b) the cached callback reads the current item (and the current `onLineTap`)
//       through refs, so it never goes stale when the item is rebuilt;
//   (c) a non-selectable line still gets `onTap === undefined`.

import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  type LineTapArgs,
  useDiffRenderItem,
} from '@/components/pr-review/diff/pr-diff-file-list-render';
import { type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type ParsedDiffLine, type ParsedPatch } from '@/lib/pr-review/diff/parse-patch';

// The heavy children are string hosts: this suite exercises only the props
// `useDiffRenderItem` binds, not how the row itself renders.
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
}));
vi.mock('@/components/pr-review/diff/diff-line', () => ({ DiffLine: 'DiffLine' }));
vi.mock('@/components/pr-review/diff/pr-diff-rows', () => ({
  ExpandSeparatorRow: 'ExpandSeparatorRow',
  FileHeaderRow: 'FileHeaderRow',
  HunkHeaderRow: 'HunkHeaderRow',
  PaginationRow: 'PaginationRow',
  PatchMissingRow: 'PatchMissingRow',
  TruncationBannerRow: 'TruncationBannerRow',
}));
vi.mock('@/components/pr-review/diff/pr-diff-side-by-side-row', () => ({
  HunkSideBySideHeader: 'HunkSideBySideHeader',
  SideBySideRow: 'SideBySideRow',
}));

type DiffLineItem = Extract<ListItem, { kind: 'diff-line' }>;

type SelectionView = {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number;
  line: number;
} | null;

type HarnessProps = {
  item: DiffLineItem;
  onLineTap: (args: LineTapArgs) => void;
  selection: SelectionView;
};

// A minimal host for the hook: mount it, then `renderer.update` with a new
// `selection` / item to force the re-render the memo has to survive.
function Harness({ item, onLineTap, selection }: Readonly<HarnessProps>) {
  const renderItem = useDiffRenderItem({
    viewed: { isViewed: () => false, toggle: vi.fn() },
    onRetryPage: () => undefined,
    onFetchAll: () => undefined,
    handleLoadContext: () => undefined,
    setExpanded: () => undefined,
    onLineTap,
    selection,
  });
  return <>{renderItem({ item })}</>;
}

// One builder for the whole line, so a rebuilt item keeps the same `key` (the
// map binds by key) but changes every argument the tap carries.
function buildItem(text: string, newLine: number, selectable?: boolean): DiffLineItem {
  const line: ParsedDiffLine = { type: 'add', newLine, text, noNewlineAtEndOfFile: false };
  const parsed: ParsedPatch = {
    isRename: false,
    hunks: [
      {
        header: '@@ -1,1 +1,2 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [line],
      },
    ],
  };
  return {
    kind: 'diff-line',
    key: 'line:src/a.ts:0:0',
    lineKey: 'src/a.ts:0:0',
    filePath: 'src/a.ts',
    hunkIndex: 0,
    lineIndex: 0,
    parsed,
    line,
    language: 'typescript',
    lineKeyId: 'line:src/a.ts:0:0',
    ...(selectable === undefined ? {} : { selectable }),
  };
}

function mount(node: ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(node);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function diffLineProps(renderer: TestRenderer.ReactTestRenderer): Record<string, unknown> {
  return renderer.root.find(node => String(node.type) === 'DiffLine').props;
}

describe('useDiffRenderItem per-line onTap identity', () => {
  it('keeps the same onTap reference across a selection-only re-render', () => {
    const onLineTap = vi.fn<(args: LineTapArgs) => void>();
    const item = buildItem('beta', 2);
    const renderer = mount(createElement(Harness, { item, onLineTap, selection: null }));
    const before = diffLineProps(renderer).onTap;
    expect(typeof before).toBe('function');

    act(() => {
      renderer.update(
        createElement(Harness, {
          item,
          onLineTap,
          selection: { filePath: 'src/a.ts', side: 'RIGHT', startLine: 2, line: 2 },
        })
      );
    });

    expect(diffLineProps(renderer).onTap).toBe(before);
  });

  it('invokes onLineTap with the current item after the item is rebuilt', () => {
    const onLineTap = vi.fn<(args: LineTapArgs) => void>();
    const renderer = mount(
      createElement(Harness, { item: buildItem('beta', 2), onLineTap, selection: null })
    );
    const tap = diffLineProps(renderer).onTap as () => void;

    // Same key, new text / line number / parsed hunk, and a fresh `onLineTap`:
    // a stale closure would still report the first render's values (or the
    // first `onLineTap`).
    const rebuilt = buildItem('beta changed', 7);
    const nextOnLineTap = vi.fn<(args: LineTapArgs) => void>();
    act(() => {
      renderer.update(
        createElement(Harness, { item: rebuilt, onLineTap: nextOnLineTap, selection: null })
      );
    });

    expect(diffLineProps(renderer).onTap).toBe(tap);
    act(() => {
      tap();
    });
    expect(nextOnLineTap).toHaveBeenCalledWith({
      filePath: 'src/a.ts',
      hunkKey: 'src/a.ts:0',
      side: 'RIGHT',
      line: 7,
      text: 'beta changed',
      hunk: rebuilt.parsed.hunks[0],
    });
    expect(onLineTap).not.toHaveBeenCalled();
  });

  it('leaves a non-selectable line without a tap affordance', () => {
    const onLineTap = vi.fn<(args: LineTapArgs) => void>();
    const renderer = mount(
      createElement(Harness, { item: buildItem('gap', 9, false), onLineTap, selection: null })
    );

    expect(diffLineProps(renderer).onTap).toBeUndefined();
  });
});
