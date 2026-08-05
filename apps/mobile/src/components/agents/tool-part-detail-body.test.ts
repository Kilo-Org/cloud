import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolPartDetailBody } from './tool-part-detail-body';
import {
  BashToolCardBody,
  EditToolCardBody,
  GenericToolCardBody,
  GlobToolCardBody,
  GrepToolCardBody,
  ListToolCardBody,
  ReadToolCardBody,
  TaskToolCardBody,
  TodoToolCardBody,
  WebSearchToolCardBody,
  WriteToolCardBody,
} from './tool-cards';
import { BashToolCardBody as RealBashToolCardBody } from './tool-cards/bash-tool-card';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('lucide-react-native', () => ({ Terminal: 'Terminal' }));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('./mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('./fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('./tool-card-display', () => ({
  getToolDisplay: vi.fn(),
  toolPartHasDetails: vi.fn(),
}));
vi.mock('./tool-card-image-attachments', () => ({
  ToolCardImageAttachments: 'ToolCardImageAttachments',
}));
vi.mock('./tool-card-file-attachments', () => ({
  ToolCardFileAttachments: 'ToolCardFileAttachments',
}));

const { getToolImageAttachments, getToolFileAttachments } = vi.hoisted(() => ({
  getToolImageAttachments: vi.fn<() => FilePart[]>(() => []),
  getToolFileAttachments: vi.fn<() => FilePart[]>(() => []),
}));
vi.mock('./tool-card-attachments', () => ({ getToolImageAttachments, getToolFileAttachments }));

vi.mock('./tool-cards', () => ({
  BashToolCardBody: 'BashToolCardBody',
  EditToolCardBody: 'EditToolCardBody',
  GenericToolCardBody: 'GenericToolCardBody',
  GlobToolCardBody: 'GlobToolCardBody',
  GrepToolCardBody: 'GrepToolCardBody',
  ListToolCardBody: 'ListToolCardBody',
  ReadToolCardBody: 'ReadToolCardBody',
  TaskToolCardBody: 'TaskToolCardBody',
  TodoToolCardBody: 'TodoToolCardBody',
  WebSearchToolCardBody: 'WebSearchToolCardBody',
  WriteToolCardBody: 'WriteToolCardBody',
}));

const completedState: Extract<ToolPart['state'], { status: 'completed' }> = {
  status: 'completed',
  input: { command: 'echo hi' },
  output: 'hi',
  title: 'bash',
  metadata: {},
  time: { start: 1, end: 2 },
};

const runningState: Extract<ToolPart['state'], { status: 'running' }> = {
  status: 'running',
  input: { command: 'echo hi' },
  time: { start: 1 },
};

const pendingState: Extract<ToolPart['state'], { status: 'pending' }> = {
  status: 'pending',
  input: { command: 'echo hi' },
  raw: '',
};

const errorState: Extract<ToolPart['state'], { status: 'error' }> = {
  status: 'error',
  input: {},
  error: 'boom',
  time: { start: 1, end: 2 },
};

function makeToolPart(tool: string, state: ToolPart['state']): ToolPart {
  return {
    id: `${tool}-1`,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state,
  };
}

function makeFilePart(id: string, mime: string): FilePart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'file',
    mime,
    url: '',
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
      walk((value.props as Record<string, unknown>).children);
    }
  }
  walk(node);
  return matches;
}

function findByType(node: unknown, type: string | ToolBody): React.ReactElement[] {
  return findAll(node, el => el.type === type);
}

function orderedTypes(node: unknown): (string | React.ComponentType)[] {
  const types: (string | React.ComponentType)[] = [];
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
      types.push(value.type as string | React.ComponentType);
      walk((value.props as Record<string, unknown>).children);
    }
  }
  walk(node);
  return types;
}

const textChildren = (el: React.ReactElement): unknown =>
  (el.props as { children?: unknown }).children;

/** Join JSX children so `$ {command}` renders as one comparable string. */
function renderedText(el: React.ReactElement): string {
  const children = textChildren(el);
  if (Array.isArray(children)) {
    return children.filter(child => typeof child === 'string').join('');
  }
  return typeof children === 'string' ? children : '';
}

type ToolBody = React.ComponentType<{ part: ToolPart }>;

const routingTable: [string, ToolBody][] = [
  ['read', ReadToolCardBody],
  ['edit', EditToolCardBody],
  ['write', WriteToolCardBody],
  ['bash', BashToolCardBody],
  ['glob', GlobToolCardBody],
  ['grep', GrepToolCardBody],
  ['websearch', WebSearchToolCardBody],
  ['codesearch', WebSearchToolCardBody],
  ['webfetch', WebSearchToolCardBody],
  ['list', ListToolCardBody],
  ['todoread', TodoToolCardBody],
  ['todowrite', TodoToolCardBody],
  ['task', TaskToolCardBody],
];

describe('ToolPartDetailBody routing', () => {
  beforeEach(() => {
    getToolImageAttachments.mockReturnValue([]);
    getToolFileAttachments.mockReturnValue([]);
  });

  it.each(routingTable)('routes tool %s to its body component', (tool, body) => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart(tool, completedState) });
    expect(findByType(root, body)).toHaveLength(1);
  });

  it('routes unknown tools to the generic body', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('some-new-tool', completedState) });
    expect(findByType(root, GenericToolCardBody)).toHaveLength(1);
  });

  it('renders no body for suggest parts', () => {
    const allBodies = [
      BashToolCardBody,
      EditToolCardBody,
      GenericToolCardBody,
      GlobToolCardBody,
      GrepToolCardBody,
      ListToolCardBody,
      ReadToolCardBody,
      TaskToolCardBody,
      TodoToolCardBody,
      WebSearchToolCardBody,
      WriteToolCardBody,
    ];
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('suggest', completedState) });
    expect(allBodies.flatMap(body => findByType(root, body))).toHaveLength(0);
  });

  it('renders attachments above the body when present', () => {
    getToolImageAttachments.mockReturnValue([makeFilePart('img-1', 'image/png')]);
    getToolFileAttachments.mockReturnValue([makeFilePart('file-1', 'application/pdf')]);
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('bash', completedState) });
    expect(orderedTypes(root)).toEqual([
      'View',
      'ToolCardImageAttachments',
      'ToolCardFileAttachments',
      'BashToolCardBody',
    ]);
  });
});

describe('ToolPartDetailBody status line', () => {
  beforeEach(() => {
    getToolImageAttachments.mockReturnValue([]);
    getToolFileAttachments.mockReturnValue([]);
  });

  it('renders the Running… status line for a running part', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('bash', runningState) });
    expect(findAll(root, el => el.type === 'Text' && textChildren(el) === 'Running…')).toHaveLength(
      1
    );
    expect(findAll(root, el => el.type === 'Text' && textChildren(el) === 'Pending…')).toHaveLength(
      0
    );
  });

  it('renders the Pending… status line for a pending part', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('bash', pendingState) });
    expect(findAll(root, el => el.type === 'Text' && textChildren(el) === 'Pending…')).toHaveLength(
      1
    );
  });

  it('renders no status line for a completed part', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('bash', completedState) });
    const statusLines = findAll(
      root,
      el =>
        el.type === 'Text' && (textChildren(el) === 'Pending…' || textChildren(el) === 'Running…')
    );
    expect(statusLines).toHaveLength(0);
  });

  it('renders no status line for an error part', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartDetailBody({ part: makeToolPart('bash', errorState) });
    const statusLines = findAll(
      root,
      el =>
        el.type === 'Text' && (textChildren(el) === 'Pending…' || textChildren(el) === 'Running…')
    );
    expect(statusLines).toHaveLength(0);
  });
});

describe('BashToolCardBody streaming contract', () => {
  it('renders the $ command block while running with a short command', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = RealBashToolCardBody({ part: makeToolPart('bash', runningState) });
    const commands = findAll(root, el => el.type === 'Text' && renderedText(el) === '$ echo hi');
    expect(commands).toHaveLength(1);
  });
});
