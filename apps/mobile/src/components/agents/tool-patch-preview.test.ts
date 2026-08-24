/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/test/render-with-providers.tsx */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import { ToolPatchPreview } from './tool-patch-preview';
import { type ToolPatchFile, type ToolPatchModel } from './tool-patch-model';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/diff/diff-line', () => ({ DiffLine: 'DiffLine' }));

function makeFile(overrides: Partial<ToolPatchFile> = {}): ToolPatchFile {
  return {
    path: 'src/app.ts',
    operation: 'update',
    lines: [
      { type: 'del', oldLine: 1, text: 'old', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 1, text: 'new', noNewlineAtEndOfFile: false },
    ],
    language: 'typescript',
    ...overrides,
  };
}

function makeModel(overrides: Partial<ToolPatchModel> = {}): ToolPatchModel {
  return { files: [makeFile()], truncated: false, ...overrides };
}

function render(model: ToolPatchModel, partId = 'part-1'): React.ReactElement {
  // eslint-disable-next-line new-cap
  return ToolPatchPreview({ model, partId }) as React.ReactElement;
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

function findText(root: React.ReactElement, text: string): React.ReactElement[] {
  return findAll(
    root,
    el => el.type === 'Text' && (el.props as { children?: unknown }).children === text
  );
}

function rootElement(node: React.ReactElement | null): React.ReactElement {
  if (!node) {
    throw new Error('expected a root element');
  }
  return node;
}

describe('ToolPatchPreview', () => {
  it('renders the file path header for every file', () => {
    const root = rootElement(
      render(makeModel({ files: [makeFile({ path: 'src/a.ts' }), makeFile({ path: 'src/b.ts' })] }))
    );
    expect(findText(root, 'src/a.ts')).toHaveLength(1);
    expect(findText(root, 'src/b.ts')).toHaveLength(1);
  });

  it('renders the operation label for every file', () => {
    const add = makeFile({ path: 'src/a.ts', operation: 'add' });
    const update = makeFile({ path: 'src/b.ts', operation: 'update' });
    const del = makeFile({ path: 'src/c.ts', operation: 'delete' });
    const root = rootElement(render(makeModel({ files: [add, update, del] })));
    expect(findText(root, 'agentChat.toolPatch.operationAdded')).toHaveLength(1);
    expect(findText(root, 'agentChat.toolPatch.operationUpdated')).toHaveLength(1);
    expect(findText(root, 'agentChat.toolPatch.operationDeleted')).toHaveLength(1);
  });

  it('renders a DiffLine for every model line', () => {
    const root = rootElement(render(makeModel()));
    expect(findByType(root, 'DiffLine')).toHaveLength(2);
  });

  it('passes the line and language to every DiffLine', () => {
    const lines: ParsedDiffLine[] = [
      { type: 'del', oldLine: 1, text: 'old', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 1, text: 'new', noNewlineAtEndOfFile: false },
    ];
    const root = rootElement(
      render(makeModel({ files: [makeFile({ lines, language: 'python' })] }))
    );
    const diffLines = findByType(root, 'DiffLine');
    expect(diffLines).toHaveLength(2);
    for (const [i, el] of diffLines.entries()) {
      expect((el.props as { line: unknown }).line).toBe(lines[i]);
      expect((el.props as { language: unknown }).language).toBe('python');
    }
  });

  it('passes keyId with partId, file index, and line index', () => {
    const lines: ParsedDiffLine[] = [
      { type: 'add', newLine: 1, text: 'a', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 2, text: 'b', noNewlineAtEndOfFile: false },
    ];
    const root = rootElement(
      render(
        makeModel({ files: [makeFile({ lines }), makeFile({ lines, path: 'src/b.ts' })] }),
        'xyz'
      )
    );
    const diffLines = findByType(root, 'DiffLine');
    expect(diffLines).toHaveLength(4);
    const [line0, line1, line2, line3] = diffLines;
    if (!line0 || !line1 || !line2 || !line3) {
      throw new Error('diffLines entries missing');
    }
    expect((line0.props as { keyId: unknown }).keyId).toBe('xyz:0:0');
    expect((line1.props as { keyId: unknown }).keyId).toBe('xyz:0:1');
    expect((line2.props as { keyId: unknown }).keyId).toBe('xyz:1:0');
    expect((line3.props as { keyId: unknown }).keyId).toBe('xyz:1:1');
  });

  it('renders the header of an empty file with no DiffLines', () => {
    const del = makeFile({ path: 'src/gone.ts', operation: 'delete', lines: [] });
    const root = rootElement(render(makeModel({ files: [del] })));
    expect(findText(root, 'src/gone.ts')).toHaveLength(1);
    expect(findText(root, 'agentChat.toolPatch.operationDeleted')).toHaveLength(1);
    expect(findByType(root, 'DiffLine')).toHaveLength(0);
  });

  it('renders an empty container when the model has no files', () => {
    const root = rootElement(render(makeModel({ files: [] })));
    expect(findByType(root, 'DiffLine')).toHaveLength(0);
    expect(findByType(root, 'Text')).toHaveLength(0);
  });

  it('shows the Truncated label when the model is truncated', () => {
    const root = rootElement(render(makeModel({ truncated: true })));
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
    const root = rootElement(render(makeModel({ truncated: false })));
    const texts = findByType(root, 'Text');
    const truncatedLabel = texts.find(
      el =>
        (el.props as { accessibilityLabel?: string }).accessibilityLabel ===
        'monoScrollBlock.contentTruncated'
    );
    expect(truncatedLabel).toBeUndefined();
  });
});
