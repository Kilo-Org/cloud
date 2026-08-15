import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WriteToolCard, WriteToolCardBody } from './write-tool-card';
import * as React from 'react';

vi.mock('react-native', () => ({ View: 'View', TextInput: 'TextInput' }));
vi.mock('lucide-react-native', () => ({ FilePlus: 'FilePlus' }));
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
vi.mock('../fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('../code-block', () => ({ CodeBlock: 'CodeBlock' }));
vi.mock('../read-markdown-body', () => ({ ReadMarkdownBody: 'ReadMarkdownBody' }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  return {
    default: actual,
    ...actual,
    // `SelectableText` is invoked directly by the pure walker, outside a React
    // render, so the real `useContext` would throw on the null dispatcher.
    useContext: () => undefined,
  };
});

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

function findErrorText(root: React.ReactElement, value: string): React.ReactElement[] {
  return findAll(
    root,
    el => el.type === 'TextInput' && (el.props as { value?: string }).value === value
  );
}

describe('WriteToolCard — fixed row', () => {
  beforeEach(() => {
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

describe('WriteToolCardBody — smart render routing', () => {
  it('routes a .md path to ReadMarkdownBody and not CodeBlock', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'README.md', content: '# Hello' }),
    }) as unknown as React.ReactElement;
    const bodies = findByType(root, 'ReadMarkdownBody');
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    if (!body) {
      throw new Error('body not found');
    }
    expect((body.props as { body: unknown }).body).toEqual({ text: '# Hello', footer: undefined });
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
  });

  it('routes a .mdx path to ReadMarkdownBody', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'page.mdx', content: '# Page' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(1);
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
  });

  it('routes a .MD path to ReadMarkdownBody', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'NOTES.MD', content: '# Notes' }),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(1);
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
  });

  it('routes a non-markdown path to CodeBlock with languageForPath', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'src/new.ts', content: 'hello world' }),
    }) as unknown as React.ReactElement;
    const blocks = findByType(root, 'CodeBlock');
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (!block) {
      throw new Error('block not found');
    }
    expect(block.props).toMatchObject({
      code: 'hello world',
      language: 'typescript',
      maxLength: 50_000,
    });
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
    expect(findByType(root, 'ToolDiffPreview')).toHaveLength(0);
  });

  it('routes an unknown extension to CodeBlock with null language', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'Makefile', content: 'x' }),
    }) as unknown as React.ReactElement;
    const block = findByType(root, 'CodeBlock')[0];
    if (!block) {
      throw new Error('block not found');
    }
    expect((block.props as { language: unknown }).language).toBeNull();
  });

  it('renders the empty line for empty non-markdown content', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'src/empty.ts', content: '' }),
    }) as unknown as React.ReactElement;
    const texts = findByType(root, 'Text');
    expect(texts).toHaveLength(1);
    const text = texts[0];
    if (!text) {
      throw new Error('text not found');
    }
    expect((text.props as { children?: unknown }).children).toBe('This file is empty.');
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
  });

  it('routes empty markdown content through ReadMarkdownBody', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({ filePath: 'README.md', content: '' }),
    }) as unknown as React.ReactElement;
    const bodies = findByType(root, 'ReadMarkdownBody');
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    if (!body) {
      throw new Error('body not found');
    }
    expect((body.props as { body: { text: string } }).body.text).toBe('');
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
  });

  it('preserves the error block next to a code body', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({
        status: 'error',
        error: 'write failed',
        filePath: 'src/new.ts',
        content: 'hello',
      }),
    }) as unknown as React.ReactElement;
    expect(findErrorText(root, 'write failed')).toHaveLength(1);
    expect(findByType(root, 'CodeBlock')).toHaveLength(1);
  });

  it('preserves the error block next to a markdown body', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = WriteToolCardBody({
      part: makeWritePart({
        status: 'error',
        error: 'write failed',
        filePath: 'README.md',
        content: '# Hello',
      }),
    }) as unknown as React.ReactElement;
    expect(findErrorText(root, 'write failed')).toHaveLength(1);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(1);
  });
});
