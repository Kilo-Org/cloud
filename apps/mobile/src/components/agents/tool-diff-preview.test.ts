/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/test/render-with-providers.tsx */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { describe, expect, it, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import { ToolDiffPreview } from './tool-diff-preview';
import { type ToolDiffModel } from './tool-diff-model';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { type DiffLine as DiffLineComponent } from '@/components/pr-review/diff/diff-line';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'RNText',
  Pressable: 'Pressable',
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#FBFAF5',
    foreground: '#14130F',
    good: '#278150',
    destructive: '#BE4E3F',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/lib/pr-review/diff/highlight', () => ({
  highlightLine: (text: string) => [{ text, className: null }],
}));
vi.mock('@/components/pr-review/diff/diff-line', () => ({ DiffLine: 'DiffLine' }));

function makeModel(overrides: Partial<ToolDiffModel> = {}): ToolDiffModel {
  return {
    lines: [
      { type: 'del', oldLine: 1, text: 'old', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 1, text: 'new', noNewlineAtEndOfFile: false },
    ],
    filePath: 'src/app.tsx',
    language: 'typescript',
    truncated: false,
    tool: 'edit',
    ...overrides,
  };
}

function render(m: ToolDiffModel, partId = 'part-1'): React.ReactElement {
  // eslint-disable-next-line new-cap
  return ToolDiffPreview({ model: m, partId }) as React.ReactElement;
}

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];

  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as { children?: unknown };
      walk(props.children);
    }
  }

  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

function rootElement(node: React.ReactElement | null): React.ReactElement {
  if (!node) {
    throw new Error('expected a root element');
  }
  return node;
}

describe('ToolDiffPreview', () => {
  it('renders a DiffLine for every model line', () => {
    const root = rootElement(render(makeModel({ language: null })));
    const diffLines = findByType(root, 'DiffLine');
    expect(diffLines).toHaveLength(2);
  });

  it('passes the language prop to every DiffLine', () => {
    const root = rootElement(render(makeModel({ language: 'python' })));
    const diffLines = findByType(root, 'DiffLine');
    for (const el of diffLines) {
      expect((el.props as { language: unknown }).language).toBe('python');
    }
  });

  it('passes keyId with partId and index', () => {
    const root = rootElement(render(makeModel({ language: null }), 'xyz'));
    const diffLines = findByType(root, 'DiffLine');
    expect(diffLines[0]).not.toBeUndefined();
    expect(diffLines[1]).not.toBeUndefined();
    const line0 = diffLines[0];
    const line1 = diffLines[1];
    if (!line0 || !line1) {
      throw new Error('diffLines entries missing');
    }
    expect((line0.props as { keyId: unknown }).keyId).toBe('xyz:0');
    expect((line1.props as { keyId: unknown }).keyId).toBe('xyz:1');
  });

  it('omits onTap from every DiffLine (read-only preview)', () => {
    const root = rootElement(render(makeModel({ language: null })));
    const diffLines = findByType(root, 'DiffLine');
    for (const el of diffLines) {
      expect((el.props as { onTap?: unknown }).onTap).toBeUndefined();
    }
  });

  it('omits isSelected from every DiffLine', () => {
    const root = rootElement(render(makeModel({ language: null })));
    const diffLines = findByType(root, 'DiffLine');
    for (const el of diffLines) {
      expect((el.props as { isSelected?: unknown }).isSelected).toBeUndefined();
    }
  });

  it('shows the Truncated label when the model is truncated', () => {
    const root = rootElement(render(makeModel({ truncated: true, language: null })));
    const texts = findByType(root, 'Text');
    const truncatedLabel = texts.find(
      el =>
        (el.props as { accessibilityLabel?: string }).accessibilityLabel ===
        'monoScrollBlock.contentTruncated'
    );
    expect(truncatedLabel).toBeDefined();
    if (!truncatedLabel) {
      throw new Error('truncatedLabel not found');
    }
    expect((truncatedLabel.props as { children?: string }).children).toBe(
      'monoScrollBlock.truncated'
    );
  });

  it('does not show the Truncated label when the model is not truncated', () => {
    const root = rootElement(render(makeModel({ truncated: false, language: null })));
    const texts = findByType(root, 'Text');
    const truncatedLabel = texts.find(
      el =>
        (el.props as { accessibilityLabel?: string }).accessibilityLabel ===
        'monoScrollBlock.contentTruncated'
    );
    expect(truncatedLabel).toBeUndefined();
  });

  it('renders an empty container when the model has no lines', () => {
    const root = rootElement(render(makeModel({ lines: [], language: null, truncated: false })));
    const diffLines = findByType(root, 'DiffLine');
    expect(diffLines).toHaveLength(0);
  });
});

describe('DiffLine code container accessibility', () => {
  // The E2E edit-detail hierarchy failed S3 because the code container's
  // `accessibilityLabel` was set but the container was not marked
  // `accessible`, so iOS exposed only the selectable code text. This test
  // mounts the REAL `DiffLine` (bypassing the string mock used above) and
  // proves the code container is the accessibility element carrying the
  // status word + line number.
  it('exposes the status word and line number on the rendered code container', async () => {
    const { DiffLine } = await vi.importActual<{ DiffLine: typeof DiffLineComponent }>(
      '@/components/pr-review/diff/diff-line'
    );

    const deletedLine: ParsedDiffLine = {
      type: 'del',
      oldLine: 1,
      text: 'greeting = "hello"',
      noNewlineAtEndOfFile: false,
    };
    const addedLine: ParsedDiffLine = {
      type: 'add',
      newLine: 1,
      text: 'greeting = "goodbye"',
      noNewlineAtEndOfFile: false,
    };

    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(DiffLine, { line: deletedLine, language: 'typescript', keyId: 'k0' }),
          React.createElement(DiffLine, { line: addedLine, language: 'typescript', keyId: 'k1' })
        )
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const codeContainers = renderer.root.findAll(node => {
      const props = node.props as { accessibilityLabel?: string } | null;
      return typeof props?.accessibilityLabel === 'string';
    });
    expect(codeContainers).toHaveLength(2);

    const labels = codeContainers
      .map(node => node.props as { accessibilityLabel: string; accessible?: boolean })
      .toSorted((a, b) => a.accessibilityLabel.localeCompare(b.accessibilityLabel));

    expect(labels[0]?.accessibilityLabel).toBe('Added line 1: greeting = "goodbye"');
    expect(labels[1]?.accessibilityLabel).toBe('Deleted line 1: greeting = "hello"');
    for (const host of labels) {
      expect(host.accessible).toBe(true);
    }
  });
});
