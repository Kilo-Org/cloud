// oxlint-disable max-lines
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReadToolMarkdownModule from '../read-tool-markdown';

import { BashToolCardBody } from './bash-tool-card';
import { GenericToolCardBody } from './generic-tool-card';
import { GlobToolCardBody } from './glob-tool-card';
import { GrepToolCardBody } from './grep-tool-card';
import { ListToolCardBody } from './list-tool-card';
import { ReadToolCardBody } from './read-tool-card';
import { TaskToolCardBody } from './task-tool-card';
import { TodoToolCardBody } from './todo-tool-card';
import { WebSearchToolCardBody } from './web-search-tool-card';
import { prepareMonoScrollContent } from '../mono-scroll-block-model';

vi.mock('react-native', () => ({ View: 'View', TextInput: 'TextInput' }));
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
vi.mock('@/components/ui/icons', () => ({
  Terminal: 'Terminal',
  Search: 'Search',
  FileSearch: 'FileSearch',
  FolderOpen: 'FolderOpen',
  Eye: 'Eye',
  Cpu: 'Cpu',
  ListTodo: 'ListTodo',
  Globe: 'Globe',
  Plug: 'Plug',
}));
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
vi.mock('../open-part-detail-context', () => ({ useOpenPartDetail: () => openSpy }));
vi.mock('../tool-card-display', () => ({ getToolDisplay, toolPartHasDetails }));
vi.mock('../read-markdown-body', () => ({ ReadMarkdownBody: 'ReadMarkdownBody' }));
vi.mock('../tool-result-rows', () => ({ ToolResultRows: 'ToolResultRows' }));
// Stops the direct-call walker before TodoTaskRows' `useThemeColors` call.
vi.mock('./todo-task-rows', () => ({ TodoTaskRows: 'TodoTaskRows' }));
vi.mock('../code-block', () => ({ CodeBlock: 'CodeBlock' }));
vi.mock('../tool-list-model', () => ({ buildResultRowsModel, buildTodoListModel }));

const {
  getToolImageAttachments,
  isMarkdownPath,
  resolveMarkdownBody,
  resolveReadCodeBody,
  openSpy,
  getToolDisplay,
  toolPartHasDetails,
  buildResultRowsModel,
  buildTodoListModel,
} = vi.hoisted(() => ({
  getToolImageAttachments: vi.fn(() => []),
  isMarkdownPath: vi.fn(() => false),
  resolveMarkdownBody: vi.fn(),
  resolveReadCodeBody: vi.fn(),
  openSpy: vi.fn(),
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
  buildResultRowsModel: vi.fn(),
  buildTodoListModel: vi.fn(),
}));
vi.mock('../tool-card-attachments', () => ({ getToolImageAttachments }));
// The real read model keeps its helpers; the three resolvers are spies so the
// read body's routing can be driven and asserted.
vi.mock('../read-tool-markdown', async importOriginal => {
  const actual = await importOriginal<typeof ReadToolMarkdownModule>();
  return { ...actual, isMarkdownPath, resolveMarkdownBody, resolveReadCodeBody };
});

/**
 * A 20000-character output with one 4000-character line and no newline in it,
 * so a truncated render would be provable by length alone.
 */
const longOutput = `${'x'.repeat(4000)}\n${'y'.repeat(15_999)}`;

// Mirrors `read-tool-card.tsx`'s module-local `READ_CODE_CHARACTER_CAP`.
const READ_CODE_CHARACTER_CAP = 50_000;

function makeCompletedPart(tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id: `${tool}-1`,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input,
      output: longOutput,
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
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
      const props = value.props as Record<string, unknown>;
      // Walk the rendered output of function components so their
      // children are visible to predicate matching.
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

/** Bodies that keep the uncapped MonoScrollBlock contract. */
type MonoBodyCase = {
  name: string;
  body: (props: { part: ToolPart }) => React.ReactElement;
  part: ToolPart;
  /** Mono blocks per body: the output block, plus the input JSON for generic. */
  blockCount: number;
};

const monoBodies: MonoBodyCase[] = [
  {
    name: 'BashToolCardBody',
    body: BashToolCardBody,
    part: makeCompletedPart('bash', { command: 'echo hi' }),
    blockCount: 1,
  },
  {
    name: 'TaskToolCardBody',
    body: TaskToolCardBody,
    part: makeCompletedPart('task', {}),
    blockCount: 1,
  },
  {
    name: 'WebSearchToolCardBody',
    body: WebSearchToolCardBody,
    part: makeCompletedPart('websearch', {}),
    blockCount: 1,
  },
  {
    // Generic renders the input JSON block and the output block.
    name: 'GenericToolCardBody',
    body: GenericToolCardBody,
    part: makeCompletedPart('generic', { command: 'echo hi' }),
    blockCount: 2,
  },
];

/** Bodies rewired to the shared result rows component. */
type ResultRowBodyCase = {
  name: string;
  body: (props: { part: ToolPart }) => React.ReactElement;
  part: ToolPart;
  kind: 'grep' | 'glob' | 'list';
};

const resultRowBodies: ResultRowBodyCase[] = [
  {
    name: 'GrepToolCardBody',
    body: GrepToolCardBody,
    part: makeCompletedPart('grep', {}),
    kind: 'grep',
  },
  {
    name: 'GlobToolCardBody',
    body: GlobToolCardBody,
    part: makeCompletedPart('glob', {}),
    kind: 'glob',
  },
  {
    name: 'ListToolCardBody',
    body: ListToolCardBody,
    part: makeCompletedPart('list', {}),
    kind: 'list',
  },
];

describe('tool-card output caps removed', () => {
  beforeEach(() => {
    buildResultRowsModel.mockReset();
    buildTodoListModel.mockReset();
    resolveReadCodeBody.mockReset();
    resolveMarkdownBody.mockReset();
    isMarkdownPath.mockReset();
    getToolDisplay.mockReset();
    toolPartHasDetails.mockReset();
    openSpy.mockReset();
    getToolImageAttachments.mockReturnValue([]);
  });

  it.each(monoBodies)(
    '$name passes the full output to MonoScrollBlock with no cap',
    ({ body, part, blockCount }) => {
      // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
      const root = body({ part }) as unknown as React.ReactElement;
      const blocks = findByType(root, 'MonoScrollBlock');
      expect(blocks).toHaveLength(blockCount);
      for (const block of blocks) {
        expect((block.props as { maxLength?: unknown }).maxLength).toBeUndefined();
      }
      const outputBlocks = blocks.filter(
        block => (block.props as { content?: unknown }).content === longOutput
      );
      expect(outputBlocks).toHaveLength(1);
    }
  );

  it.each(resultRowBodies)(
    '$name passes the full output to buildResultRowsModel and renders the model rows',
    ({ body, part, kind }) => {
      const model = {
        caption: 'Found 1 result',
        rows: [{ text: 'a.ts', emphasis: true }],
        truncated: false,
      };
      buildResultRowsModel.mockReturnValue(model);
      // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
      const root = body({ part }) as unknown as React.ReactElement;
      expect(buildResultRowsModel).toHaveBeenCalledWith(longOutput, kind);
      const rowElements = findByType(root, 'ToolResultRows');
      expect(rowElements).toHaveLength(1);
      const rowElement = rowElements[0];
      if (!rowElement) {
        throw new Error('row element not found');
      }
      const rowProps = rowElement.props as {
        caption?: unknown;
        rows?: unknown;
        truncated?: unknown;
      };
      expect(rowProps.caption).toBe(model.caption);
      expect(rowProps.rows).toBe(model.rows);
      expect(rowProps.truncated).toBe(false);
      expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
    }
  );

  it('TodoToolCardBody falls back to MonoScrollBlock with the full output when no todos parse', () => {
    buildTodoListModel.mockReturnValue(null);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = TodoToolCardBody({
      part: makeCompletedPart('todoread', {}),
    }) as unknown as React.ReactElement;
    const blocks = findByType(root, 'MonoScrollBlock');
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (!block) {
      throw new Error('fallback block not found');
    }
    expect((block.props as { content?: unknown }).content).toBe(longOutput);
    expect((block.props as { maxLength?: unknown }).maxLength).toBeUndefined();
  });

  it('TodoToolCardBody renders TodoTaskRows with the model tasks', () => {
    const model = {
      tasks: [{ content: 'task one', status: 'pending' as const }],
      truncated: false,
    };
    buildTodoListModel.mockReturnValue(model);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = TodoToolCardBody({
      part: makeCompletedPart('todowrite', { todos: [] }),
    }) as unknown as React.ReactElement;
    const rowElements = findByType(root, 'TodoTaskRows');
    expect(rowElements).toHaveLength(1);
    const rowElement = rowElements[0];
    if (!rowElement) {
      throw new Error('todo rows not found');
    }
    expect((rowElement.props as { tasks?: unknown }).tasks).toBe(model.tasks);
    expect((rowElement.props as { truncated?: unknown }).truncated).toBe(false);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('TodoToolCardBody shows No tasks. for an empty parsed list', () => {
    buildTodoListModel.mockReturnValue({ tasks: [], truncated: false });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = TodoToolCardBody({
      part: makeCompletedPart('todoread', {}),
    }) as unknown as React.ReactElement;
    // `SelectableText` renders a read-only `TextInput` whose text flows
    // through the `value` prop, not a `Text` element with children.
    const inputs = findByType(root, 'TextInput');
    expect(inputs.some(el => (el.props as { value?: unknown }).value === 'No tasks.')).toBe(true);
    expect(findByType(root, 'TodoTaskRows')).toHaveLength(0);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('routes a completed code read through CodeBlock with the full text and the read cap', () => {
    resolveReadCodeBody.mockReturnValue({
      text: longOutput,
      path: 'src/main.ts',
      footer: undefined,
    });
    const part = makeCompletedPart('read', { filePath: 'src/main.ts' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadToolCardBody({ part }) as unknown as React.ReactElement;
    const codeBlocks = findByType(root, 'CodeBlock');
    expect(codeBlocks).toHaveLength(1);
    const codeBlock = codeBlocks[0];
    if (!codeBlock) {
      throw new Error('code block not found');
    }
    expect((codeBlock.props as { code?: unknown }).code).toBe(longOutput);
    expect((codeBlock.props as { maxLength?: unknown }).maxLength).toBe(READ_CODE_CHARACTER_CAP);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('routes a markdown read to ReadMarkdownBody with the full body and no mono block', () => {
    isMarkdownPath.mockReturnValue(true);
    const markdownBody = { text: '# Full', footer: undefined };
    resolveMarkdownBody.mockReturnValue(markdownBody);
    const part = makeCompletedPart('read', { filePath: 'README.md' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadToolCardBody({ part }) as unknown as React.ReactElement;
    const bodyElements = findByType(root, 'ReadMarkdownBody');
    expect(bodyElements).toHaveLength(1);
    const bodyElement = bodyElements[0];
    if (!bodyElement) {
      throw new Error('body not found');
    }
    expect((bodyElement.props as { body?: unknown }).body).toBe(markdownBody);
    expect(findByType(root, 'MonoScrollBlock')).toHaveLength(0);
  });

  it('keeps the error text and renders no body for an error read', () => {
    isMarkdownPath.mockReturnValue(true);
    resolveMarkdownBody.mockReturnValue(undefined);
    const part: ToolPart = {
      id: 'read-error-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'error',
        input: { filePath: 'README.md' },
        error: 'boom',
        time: { start: 0, end: 1 },
      },
    };
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadToolCardBody({ part }) as unknown as React.ReactElement;
    expect(resolveMarkdownBody).toHaveBeenCalledWith(part);
    // `SelectableText` renders a read-only `TextInput` whose text flows
    // through the `value` prop, not a `Text` element with children.
    const inputs = findByType(root, 'TextInput');
    expect(inputs.some(el => (el.props as { value?: unknown }).value === 'boom')).toBe(true);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
  });

  it('renders This file is empty. for an empty completed read', () => {
    resolveReadCodeBody.mockReturnValue({ text: '', path: 'src/empty.ts', footer: undefined });
    const part = makeCompletedPart('read', { filePath: 'src/empty.ts' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadToolCardBody({ part }) as unknown as React.ReactElement;
    const emptyTexts = findAll(
      root,
      el =>
        el.type === 'Text' &&
        (el.props as { children?: unknown }).children === 'This file is empty.'
    );
    expect(emptyTexts).toHaveLength(1);
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
  });

  it('falls back to the raw output CodeBlock when the read display is malformed', () => {
    resolveReadCodeBody.mockReturnValue(undefined);
    const part = makeCompletedPart('read', { filePath: 'src/main.ts' });
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadToolCardBody({ part }) as unknown as React.ReactElement;
    const codeBlocks = findByType(root, 'CodeBlock');
    expect(codeBlocks).toHaveLength(1);
    const codeBlock = codeBlocks[0];
    if (!codeBlock) {
      throw new Error('code block not found');
    }
    expect((codeBlock.props as { code?: unknown }).code).toBe(longOutput);
    expect((codeBlock.props as { maxLength?: unknown }).maxLength).toBe(READ_CODE_CHARACTER_CAP);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
  });

  it.each([
    {
      name: 'pending',
      state: { status: 'pending' as const, input: { filePath: 'src/main.ts' }, raw: '' },
    },
    {
      name: 'running',
      state: {
        status: 'running' as const,
        input: { filePath: 'src/main.ts' },
        time: { start: 0 },
      },
    },
  ])('$name reads render no body; the status line lives in the dispatcher', ({ state }) => {
    const part: ToolPart = {
      id: 'read-status-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state,
    };
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadToolCardBody({ part }) as unknown as React.ReactElement;
    expect(findByType(root, 'CodeBlock')).toHaveLength(0);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
    expect(findByType(root, 'TextInput')).toHaveLength(0);
    expect(findAll(root, el => el.type === 'Text')).toHaveLength(0);
  });

  it('prepareMonoScrollContent keeps the full output when maxLength is undefined', () => {
    expect(prepareMonoScrollContent(longOutput, undefined)).toEqual({
      displayText: longOutput,
      isTruncated: false,
    });
  });
});
