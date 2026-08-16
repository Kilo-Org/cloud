import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolDiffModel } from '../tool-diff-model';
import { WriteToolCard, WriteToolCardBody } from './write-tool-card';
import * as React from 'react';

vi.mock('react-native', () => ({ View: 'View', TextInput: 'TextInput' }));
vi.mock('@/components/ui/icons', () => ({ FilePlus: 'FilePlus' }));
// Real context so the shared `SelectableText` can call `useContext(TextClassContext)`.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return {
    Text: 'Text',
    TextClassContext: createContext<string | undefined>(undefined),
  };
});
vi.mock('../bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('../mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('../fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('../tool-diff-preview', () => ({ ToolDiffPreview: 'ToolDiffPreview' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return {
    default: actual,
    ...actual,
    useMemo: <T>(fn: () => T): T => fn(),
    // `SelectableText` is invoked directly by the pure walker, outside a React
    // render, so the real `useContext` would throw on the null dispatcher.
    useContext: () => undefined,
  };
});

const { buildToolDiffModel } = vi.hoisted(() => ({
  buildToolDiffModel: vi.fn(),
}));
vi.mock('../tool-diff-model', () => ({ buildToolDiffModel }));

const { getToolDisplay, toolPartHasDetails, openSpy } = vi.hoisted(() => ({
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
  openSpy: vi.fn(),
}));
vi.mock('../tool-card-display', () => ({ getToolDisplay, toolPartHasDetails }));
vi.mock('../open-part-detail-context', () => ({ useOpenPartDetail: () => openSpy }));

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
      if (typeof value.type === 'function') {
        walk((value.type as React.FunctionComponent<unknown>)(props));
      }
      walk(props.children);
    }
  }
  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

describe('WriteToolCard — fixed row', () => {
  beforeEach(() => {
    buildToolDiffModel.mockReset();
    getToolDisplay.mockReset();
    toolPartHasDetails.mockReset();
    openSpy.mockReset();
  });

  it('renders a FixedPartRow with the display projection and status', () => {
    getToolDisplay.mockReturnValue({ title: 'write', subtitle: 'new.ts' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({ part: makeWritePart({}) }) as unknown as React.ReactElement;
    const rows = findByType(root, 'FixedPartRow');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error('row not found');
    }
    const rowProps = row.props as {
      icon: string;
      label: string;
      status: string;
      accessibilityLabel: string;
      badge?: unknown;
    };
    expect(rowProps).toMatchObject({
      icon: 'FilePlus',
      label: 'new.ts',
      status: 'completed',
      accessibilityLabel: 'new.ts tool, completed',
    });
    expect(rowProps.badge).toBeUndefined();
  });

  it('wires onPress to openPartDetail with the part id when details exist', () => {
    getToolDisplay.mockReturnValue({ title: 'write', subtitle: 'new.ts' });
    toolPartHasDetails.mockReturnValue(true);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({ part: makeWritePart({}) }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    const onPress = (row.props as { onPress?: unknown }).onPress as () => void;
    expect(onPress).toBeTypeOf('function');
    onPress();
    expect(openSpy).toHaveBeenCalledWith('write-1');
  });

  it('leaves onPress undefined when details do not exist', () => {
    getToolDisplay.mockReturnValue({ title: 'write', subtitle: 'new.ts' });
    toolPartHasDetails.mockReturnValue(false);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCard({ part: makeWritePart({}) }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    expect((row.props as { onPress?: unknown }).onPress).toBeUndefined();
  });
});

describe('WriteToolCardBody — diff preview routing', () => {
  beforeEach(() => {
    buildToolDiffModel.mockReset();
  });

  it('renders ToolDiffPreview when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({ part: makeWritePart({}) }) as unknown as React.ReactElement;
    const previews = findByType(root, 'ToolDiffPreview');
    expect(previews).toHaveLength(1);
  });

  it('passes the model and partId to ToolDiffPreview', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({ part: makeWritePart({}) }) as unknown as React.ReactElement;
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
    const root = WriteToolCardBody({
      part: makeWritePart({ content: 'hello' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    const blocks = findByType(root, 'MonoScrollBlock');
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (!block) {
      throw new Error('block not found');
    }
    expect((block.props as { maxLength?: unknown }).maxLength).toBeUndefined();
  });

  it('renders no body when the model does not exist and content is empty', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ content: '' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('preserves the error block when the model exists', () => {
    const model = makeModel();
    buildToolDiffModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ status: 'error', error: 'write failed' }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el => el.type === 'TextInput' && (el.props as { value?: string }).value === 'write failed'
    );
    expect(texts).toHaveLength(1);
  });

  it('preserves the error block when the model does not exist', () => {
    buildToolDiffModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ content: 'hello', status: 'error', error: 'write error' }),
    }) as unknown as React.ReactElement;
    const texts = findAll(
      root,
      el => el.type === 'TextInput' && (el.props as { value?: string }).value === 'write error'
    );
    expect(texts).toHaveLength(1);
  });
});
