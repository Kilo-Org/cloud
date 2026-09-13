/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as pr-diff-hunk-rows.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { DiffLine } from './diff-line';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'RNText',
  View: 'View',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#FFFFFF',
    foreground: '#111111',
    good: '#0a0',
    destructive: '#d00',
    mutedForeground: '#777777',
  }),
}));

function line(overrides: Partial<ParsedDiffLine> = {}): ParsedDiffLine {
  return {
    type: 'context',
    oldLine: 12,
    newLine: 12,
    text: 'const value = computeSomething(x);',
    noNewlineAtEndOfFile: false,
    ...overrides,
  };
}

/** Mount a DiffLine inside act, so subscription updates stay inside it. */
function mountLine(props: {
  line: ParsedDiffLine;
  language: string | null;
  keyId: string;
}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(DiffLine, props));
  });
  const created = ref.current;
  if (created === null) {
    throw new Error('the diff line did not render');
  }
  return created;
}

/** The row is the only `flex-row items-stretch` View in a DiffLine. */
function findRow(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const rows = renderer.root.findAll(
    node =>
      node.type === ('View' as never) &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex-row items-stretch')
  );
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`expected exactly one diff row, found ${rows.length}`);
  }
  return row;
}

describe('DiffLine gutter alignment', () => {
  // The row is `flex-row items-stretch`, so the gutter View stretches to the
  // row's full height. A long code line wraps and makes the row several
  // visual lines tall; the line number must sit on the FIRST visual line —
  // aligned with the code's first line via the same top padding the code
  // container uses — never centered onto a later visual line.
  it('aligns the gutter number with the start of the row on a wrapped line', () => {
    const renderer = mountLine({
      line: line({
        text: 'const wrappedValue = someVeryLongExpression(thatDoesNotFitOnOneLine, atPhoneWidth) + trailingOperand;',
      }),
      language: null,
      keyId: 'line-12',
    });

    const row = findRow(renderer);
    const [gutter, code] = row.props.children as [
      TestRenderer.ReactTestInstance,
      TestRenderer.ReactTestInstance,
    ];

    expect(gutter.props.className).toContain('justify-start');
    expect(gutter.props.className).not.toContain('justify-center');
    expect((gutter.props.style as { paddingTop: number }).paddingTop).toBe(2);
    // The code container pads by the same amount, so the gutter's first line
    // and the code's first visual line share one baseline.
    expect((code.props.style as { paddingVertical: number }).paddingVertical).toBe(2);
  });

  it('keeps the same alignment for add and delete rows', () => {
    for (const type of ['add', 'del', 'context'] as const) {
      const renderer = mountLine({ line: line({ type }), language: null, keyId: `k-${type}` });
      const row = findRow(renderer);
      const [gutter] = row.props.children as [
        TestRenderer.ReactTestInstance,
        TestRenderer.ReactTestInstance,
      ];
      expect(gutter.props.className).toContain('justify-start');
    }
  });
});
