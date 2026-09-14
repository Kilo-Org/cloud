/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as diff-line.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SideBySideRow } from './pr-diff-side-by-side-row';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { type SideBySideRow as SideBySideRowData } from '@/lib/pr-review/diff/side-by-side';

vi.mock('react-native', () => ({
  Text: 'RNText',
  View: 'View',
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#FFFFFF',
    foreground: '#111111',
    mutedForeground: '#777777',
  }),
}));

function line(overrides: Partial<ParsedDiffLine> = {}): ParsedDiffLine {
  return {
    type: 'context',
    oldLine: 7,
    newLine: 7,
    text: 'const value = computeSomething(x);',
    noNewlineAtEndOfFile: false,
    ...overrides,
  };
}

function row(overrides: Partial<ParsedDiffLine> = {}): SideBySideRowData {
  return { left: { line: line(overrides) }, right: { line: line(overrides) } };
}

function mountRow(data: SideBySideRowData): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SideBySideRow, { row: data, language: null, rowKeyId: 'row-7' })
    );
  });
  const created = ref.current;
  if (created === null) {
    throw new Error('the side-by-side row did not render');
  }
  return created;
}

describe('SideBySideRow gutter alignment', () => {
  // Same defect class as the unified DiffLine gutter: a wrapped code line
  // makes the column several visual lines tall, and a centered number would
  // drift onto a later visual line instead of the column's start.
  it('top-aligns both column gutters with the code first line', () => {
    const renderer = mountRow(
      row({
        text: 'const wrappedValue = someVeryLongExpression(thatDoesNotFitOnOneLine, atPhoneWidth);',
      })
    );

    const columns = renderer.root.findAll(
      node =>
        node.type === ('View' as never) &&
        typeof node.props.className === 'string' &&
        node.props.className.includes('flex-1 flex-row items-stretch')
    );
    expect(columns).toHaveLength(2);

    for (const column of columns) {
      const children = column.props.children as TestRenderer.ReactTestInstance[];
      const gutter = children[0];
      if (gutter === undefined) {
        throw new Error('the column rendered without a gutter');
      }
      expect(gutter.props.className).toContain('justify-start');
      expect(gutter.props.className).not.toContain('justify-center');
      expect((gutter.props.style as { paddingTop: number }).paddingTop).toBe(2);
    }
  });
});
