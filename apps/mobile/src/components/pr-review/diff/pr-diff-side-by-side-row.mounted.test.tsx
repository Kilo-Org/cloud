import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SideBySideRow } from './pr-diff-side-by-side-row';
import { MUTED_COLOR, tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { type SideBySideRow as SideBySideRowData } from '@/lib/pr-review/diff/side-by-side';

const { useColorSchemeMock } = vi.hoisted(() => ({
  useColorSchemeMock: vi.fn<() => 'dark' | 'light'>(() => 'light'),
}));

vi.mock('react-native', () => ({
  Text: 'RNText',
  View: 'View',
  useColorScheme: useColorSchemeMock,
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

function mountRow(
  data: SideBySideRowData,
  language: string | null = null
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SideBySideRow, { row: data, language, rowKeyId: 'row-7' })
    );
  });
  const created = ref.current;
  if (created === null) {
    throw new Error('the side-by-side row did not render');
  }
  return created;
}

/** The style.color of every painted run: gutter and code token runs. */
function paintedColors(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => {
      const style = node.props.style as { color?: string } | undefined;
      return typeof style?.color === 'string';
    })
    .map(node => (node.props.style as { color: string }).color);
}

describe('SideBySideRow syntax palette follows the color scheme', () => {
  // Same defect class as the unified DiffLine: the palette must come from the
  // color scheme, never from comparing a theme token to a hex literal.
  it('paints the dark token and muted palette on a dark color scheme', () => {
    useColorSchemeMock.mockReturnValue('dark');
    const renderer = mountRow(row(), 'typescript');

    const colors = paintedColors(renderer.root);
    expect(colors).toContain(tokenColorFor('keyword', true));
    expect(colors).toContain(MUTED_COLOR.dark);
    expect(colors).not.toContain(tokenColorFor('keyword', false));
  });

  it('paints the light token and muted palette on a light color scheme', () => {
    useColorSchemeMock.mockReturnValue('light');
    const renderer = mountRow(row(), 'typescript');

    const colors = paintedColors(renderer.root);
    expect(colors).toContain(tokenColorFor('keyword', false));
    expect(colors).toContain(MUTED_COLOR.light);
    expect(colors).not.toContain(tokenColorFor('keyword', true));
  });
});

describe('SideBySideRow code direction', () => {
  // Same defect class as the unified DiffLine: code reads left to right in
  // every interface language, so both column code Texts name their own base
  // direction instead of inheriting the interface's RTL one.
  it('names the left-to-right base direction on both column code texts', () => {
    const renderer = mountRow(row());

    const codeTexts = renderer.root.findAll(
      node => node.type === ('RNText' as never) && node.props.selectable === true
    );
    expect(codeTexts).toHaveLength(2);
    for (const codeText of codeTexts) {
      const style = codeText.props.style as { direction?: string; writingDirection?: string };
      expect(style.direction).toBe('ltr');
      expect(style.writingDirection).toBe('ltr');
    }
  });
});

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
