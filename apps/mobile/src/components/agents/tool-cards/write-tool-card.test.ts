import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolDiffModel } from '../tool-diff-model';
import { WriteToolCard } from './write-tool-card';
import * as React from 'react';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('lucide-react-native', () => ({ FilePlus: 'FilePlus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('../bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('../mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('../tool-card-shell', () => ({ ToolCardShell: 'ToolCardShell' }));
vi.mock('../tool-card-utils', () => ({
  getFilename: (p: string) => p.split('/').pop() ?? p,
}));
vi.mock('../tool-diff-preview', () => ({ ToolDiffPreview: 'ToolDiffPreview' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return {
    default: actual,
    ...actual,
    useMemo: <T>(fn: () => T): T => fn(),
  };
});

const { buildToolDiffModel } = vi.hoisted(() => ({
  buildToolDiffModel: vi.fn(),
}));
vi.mock('../tool-diff-model', () => ({ buildToolDiffModel }));

function makeCompletedState(overrides: {
  filePath: string;
  content: string;
}): Extract<ToolPart['state'], { status: 'completed' }> {
  return {
    status: 'completed',
    input: {
      filePath: overrides.filePath,
      content: overrides.content,
    },
    output: '',
    title: 'write',
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function makeErrorState(overrides: {
  filePath: string;
  content: string;
  error: string;
}): Extract<ToolPart['state'], { status: 'error' }> {
  return {
    status: 'error',
    input: {
      filePath: overrides.filePath,
      content: overrides.content,
    },
    error: overrides.error,
    time: { start: 0, end: 1 },
  };
}

function makeWritePart(overrides: {
  content?: string;
  filePath?: string;
  status?: string;
  error?: string;
}): ToolPart {
  const filePath = overrides.filePath ?? 'src/new.ts';
  const content = overrides.content ?? 'hello world';

  const state: ToolPart['state'] =
    overrides.status === 'error'
      ? makeErrorState({
          filePath,
          content,
          error: overrides.error ?? 'failed',
        })
      : makeCompletedState({ filePath, content });

  return {
    id: 'write-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'write',
    state,
  };
}

function makeModel(): ToolDiffModel {
  return {
    lines: [{ type: 'add', newLine: 1, text: 'hello world', noNewlineAtEndOfFile: false }],
    filePath: 'src/new.ts',
    language: 'typescript',
    truncated: false,
    tool: 'write',
  };
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

describe('WriteToolCard — diff preview routing', () => {
  beforeEach(() => {
    buildToolDiffModel.mockReset();
  });

  it('renders ToolDiffPreview when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({ part: makeWritePart({}) }) as unknown as React.ReactElement;
    const previews = findByType(root, 'ToolDiffPreview');
    expect(previews).toHaveLength(1);
  });

  it('passes the model and partId to ToolDiffPreview', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({ part: makeWritePart({}) }) as unknown as React.ReactElement;
    const preview = findByType(root, 'ToolDiffPreview')[0];
    expect(preview).toBeDefined();
    if (!preview) {
      throw new Error('preview not found');
    }
    expect((preview.props as { model: unknown }).model).toBe(model);
    expect((preview.props as { partId: unknown }).partId).toBe('write-1');
  });

  it('renders MonoScrollBlock fallback when the model does not exist', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({
      part: makeWritePart({ content: 'hello' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(1);
  });

  it('renders no body when the model does not exist and content is empty', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({
      part: makeWritePart({ content: '' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('preserves the error block when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({
      part: makeWritePart({ status: 'error', error: 'write failed' }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el => el.type === 'Text' && (el.props as { children?: string }).children === 'write failed'
    );
    expect(texts).toHaveLength(1);
  });

  it('preserves the error block when the model does not exist', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({
      part: makeWritePart({ content: 'hello', status: 'error', error: 'write error' }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el => el.type === 'Text' && (el.props as { children?: string }).children === 'write error'
    );
    expect(texts).toHaveLength(1);
  });
});
