import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { ToolDiffPreview } from './tool-diff-preview';
import { type ToolDiffModel } from './tool-diff-model';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
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
      el => (el.props as { accessibilityLabel?: string }).accessibilityLabel === 'Content truncated'
    );
    expect(truncatedLabel).toBeDefined();
    if (!truncatedLabel) {
      throw new Error('truncatedLabel not found');
    }
    expect((truncatedLabel.props as { children?: string }).children).toBe('Truncated');
  });

  it('does not show the Truncated label when the model is not truncated', () => {
    const root = rootElement(render(makeModel({ truncated: false, language: null })));
    const texts = findByType(root, 'Text');
    const truncatedLabel = texts.find(
      el => (el.props as { accessibilityLabel?: string }).accessibilityLabel === 'Content truncated'
    );
    expect(truncatedLabel).toBeUndefined();
  });

  it('renders an empty container when the model has no lines', () => {
    const root = rootElement(render(makeModel({ lines: [], language: null, truncated: false })));
    const diffLines = findByType(root, 'DiffLine');
    expect(diffLines).toHaveLength(0);
  });
});
