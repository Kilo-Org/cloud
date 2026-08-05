import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

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
vi.mock('lucide-react-native', () => ({
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
vi.mock('../read-markdown-preview', () => ({ ReadMarkdownPreview: 'ReadMarkdownPreview' }));

const {
  getToolImageAttachments,
  isMarkdownPath,
  resolveMarkdownPreview,
  openSpy,
  getToolDisplay,
  toolPartHasDetails,
} = vi.hoisted(() => ({
  getToolImageAttachments: vi.fn(() => []),
  isMarkdownPath: vi.fn(() => false),
  resolveMarkdownPreview: vi.fn(),
  openSpy: vi.fn(),
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
}));
vi.mock('../tool-card-attachments', () => ({ getToolImageAttachments }));
vi.mock('../read-tool-markdown', () => ({ isMarkdownPath, resolveMarkdownPreview }));

/**
 * A 20000-character output with one 4000-character line and no newline in it,
 * so a truncated render would be provable by length alone.
 */
const longOutput = `${'x'.repeat(4000)}\n${'y'.repeat(15_999)}`;

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

type BodyCase = {
  name: string;
  body: (props: { part: ToolPart }) => React.ReactElement;
  part: ToolPart;
  /** Mono blocks per body: the output block, plus the input JSON for generic. */
  blockCount: number;
};

const bodies: BodyCase[] = [
  {
    name: 'BashToolCardBody',
    body: BashToolCardBody,
    part: makeCompletedPart('bash', { command: 'echo hi' }),
    blockCount: 1,
  },
  {
    name: 'GlobToolCardBody',
    body: GlobToolCardBody,
    part: makeCompletedPart('glob', {}),
    blockCount: 1,
  },
  {
    name: 'GrepToolCardBody',
    body: GrepToolCardBody,
    part: makeCompletedPart('grep', {}),
    blockCount: 1,
  },
  {
    name: 'ListToolCardBody',
    body: ListToolCardBody,
    part: makeCompletedPart('list', {}),
    blockCount: 1,
  },
  {
    // A markdown path would route to ReadMarkdownPreview instead of the mono block.
    name: 'ReadToolCardBody',
    body: ReadToolCardBody,
    part: makeCompletedPart('read', { filePath: 'src/main.ts' }),
    blockCount: 1,
  },
  {
    name: 'TaskToolCardBody',
    body: TaskToolCardBody,
    part: makeCompletedPart('task', {}),
    blockCount: 1,
  },
  {
    name: 'TodoToolCardBody',
    body: TodoToolCardBody,
    part: makeCompletedPart('todoread', {}),
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

describe('tool-card output caps removed', () => {
  it.each(bodies)(
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

  it('prepareMonoScrollContent keeps the full output when maxLength is undefined', () => {
    expect(prepareMonoScrollContent(longOutput, undefined)).toEqual({
      displayText: longOutput,
      isTruncated: false,
    });
  });
});
