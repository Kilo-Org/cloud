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

vi.mock('react-native', () => ({ View: 'View' }));
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
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('../bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('../mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('../fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('../open-part-detail-context', () => ({ useOpenPartDetail: () => openSpy }));
vi.mock('../tool-card-display', () => ({ getToolDisplay, toolPartHasDetails }));
vi.mock('../read-markdown-body', () => ({ ReadMarkdownBody: 'ReadMarkdownBody' }));

const {
  getToolImageAttachments,
  isMarkdownPath,
  resolveMarkdownBody,
  openSpy,
  getToolDisplay,
  toolPartHasDetails,
} = vi.hoisted(() => ({
  getToolImageAttachments: vi.fn(() => []),
  isMarkdownPath: vi.fn(() => false),
  resolveMarkdownBody: vi.fn(),
  openSpy: vi.fn(),
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
}));
vi.mock('../tool-card-attachments', () => ({ getToolImageAttachments }));
vi.mock('../read-tool-markdown', () => ({ isMarkdownPath, resolveMarkdownBody }));

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
    // A markdown path would route to ReadMarkdownBody instead of the mono block.
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
    isMarkdownPath.mockReturnValue(false);
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
    const texts = findByType(root, 'Text');
    expect(texts.some(el => (el.props as { children?: unknown }).children === 'boom')).toBe(true);
    expect(findByType(root, 'ReadMarkdownBody')).toHaveLength(0);
    isMarkdownPath.mockReturnValue(false);
  });

  it('prepareMonoScrollContent keeps the full output when maxLength is undefined', () => {
    expect(prepareMonoScrollContent(longOutput, undefined)).toEqual({
      displayText: longOutput,
      isTruncated: false,
    });
  });
});
