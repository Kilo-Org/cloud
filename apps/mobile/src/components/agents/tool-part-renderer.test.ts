import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  BashToolCard,
  EditToolCard,
  GenericToolCard,
  GlobToolCard,
  GrepToolCard,
  ListToolCard,
  PatchToolCard,
  ReadToolCard,
  TaskToolCard,
  TodoToolCard,
  WebSearchToolCard,
  WriteToolCard,
} from './tool-cards';
import { SuggestToolCard } from './suggest-tool-card';
import { ChildSessionSection } from './child-session-section';
import { ToolPartRenderer } from './tool-part-renderer';

// The seam test must not pull in React Native, so the child-session section is
// mocked entirely. getTaskToolSessionId mirrors child-session-card-state so the
// task-with-handlers route resolves a session id; the real extraction logic has
// its own coverage in child-session-card-state.test.ts.
vi.mock('./child-session-section', () => ({
  ChildSessionSection: 'ChildSessionSection',
  getTaskToolSessionId: (part: ToolPart) => {
    if (part.tool !== 'task') {
      return undefined;
    }
    const { state } = part;
    if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
      return state.metadata?.sessionId as string | undefined;
    }
    return undefined;
  },
}));
vi.mock('./suggest-tool-card', () => ({
  SuggestToolCard: 'SuggestToolCard',
}));
vi.mock('./tool-cards', () => ({
  BashToolCard: 'BashToolCard',
  EditToolCard: 'EditToolCard',
  GenericToolCard: 'GenericToolCard',
  GlobToolCard: 'GlobToolCard',
  GrepToolCard: 'GrepToolCard',
  ListToolCard: 'ListToolCard',
  PatchToolCard: 'PatchToolCard',
  ReadToolCard: 'ReadToolCard',
  TaskToolCard: 'TaskToolCard',
  TodoToolCard: 'TodoToolCard',
  WebSearchToolCard: 'WebSearchToolCard',
  WriteToolCard: 'WriteToolCard',
}));

const completedState: Extract<ToolPart['state'], { status: 'completed' }> = {
  status: 'completed',
  input: { command: 'echo hi' },
  output: 'hi',
  title: 'bash',
  metadata: {},
  time: { start: 1, end: 2 },
};

const taskCompletedState: Extract<ToolPart['state'], { status: 'completed' }> = {
  status: 'completed',
  input: { description: 'child task', subagent_type: 'General' },
  output: '',
  title: 'task',
  metadata: { sessionId: 'child-1' },
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

function makeStoredMessage(): StoredMessage {
  return {
    info: {
      id: 'm1',
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  };
}

const modelOptions: SessionModelOption[] = [
  {
    id: 'kilo/model',
    name: 'Test Model',
    displayId: 'model',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    provider: { id: 'kilo', name: 'Kilo' },
    modelRef: { providerID: 'kilo', modelID: 'model' },
  },
];

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

function findByType(node: unknown, type: React.ElementType): React.ReactElement[] {
  return findAll(node, el => el.type === type);
}

const routingTable: [string, React.ElementType][] = [
  ['read', ReadToolCard],
  ['edit', EditToolCard],
  ['write', WriteToolCard],
  ['bash', BashToolCard],
  ['glob', GlobToolCard],
  ['grep', GrepToolCard],
  ['websearch', WebSearchToolCard],
  ['codesearch', WebSearchToolCard],
  ['webfetch', WebSearchToolCard],
  ['list', ListToolCard],
  ['patch', PatchToolCard],
  ['apply_patch', PatchToolCard],
  ['todoread', TodoToolCard],
  ['todowrite', TodoToolCard],
  ['task', TaskToolCard],
  ['suggest', SuggestToolCard],
];

describe('ToolPartRenderer routing', () => {
  it.each(routingTable)('routes tool %s to its card', (tool, card) => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartRenderer({ part: makeToolPart(tool, completedState) });
    expect(findByType(root, card)).toHaveLength(1);
  });

  it('routes unknown tools to the generic card', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartRenderer({ part: makeToolPart('some-new-tool', completedState) });
    expect(findByType(root, GenericToolCard)).toHaveLength(1);
  });

  it.each(['plan_exit', 'plan_enter'])('returns null for %s parts', tool => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const result = ToolPartRenderer({ part: makeToolPart(tool, completedState) });
    expect(result).toBeNull();
  });
});

describe('ToolPartRenderer child navigation seam', () => {
  it('routes a task part with all child handlers to ChildSessionSection with resolved messages', () => {
    const childMessage = makeStoredMessage();
    const getChildMessages = vi.fn((id: string) => (id === 'child-1' ? [childMessage] : []));
    const renderPart = vi.fn();
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();
    const part = makeToolPart('task', taskCompletedState);

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartRenderer({ part, getChildMessages, renderPart, onOpenChildSession });

    expect(getChildMessages).toHaveBeenCalledWith('child-1');
    const sections = findByType(root, ChildSessionSection);
    expect(sections).toHaveLength(1);
    const section = sections[0];
    if (!section) {
      throw new Error('expected ChildSessionSection');
    }
    expect(section.props).toMatchObject({
      part,
      childMessages: [childMessage],
      onOpenChildSession,
    });
    expect(renderPart).not.toHaveBeenCalled();
  });

  it('routes a task part without a session id to ChildSessionSection with empty messages', () => {
    const getChildMessages = vi.fn<() => StoredMessage[]>(() => []);
    const renderPart = vi.fn();
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartRenderer({
      part: makeToolPart('task', completedState),
      getChildMessages,
      renderPart,
      onOpenChildSession,
    });

    expect(getChildMessages).not.toHaveBeenCalled();
    const sections = findByType(root, ChildSessionSection);
    expect(sections).toHaveLength(1);
    const section = sections[0];
    if (!section) {
      throw new Error('expected ChildSessionSection');
    }
    expect(section.props).toMatchObject({
      part: expect.objectContaining({ tool: 'task' }),
      childMessages: [],
      onOpenChildSession,
    });
    expect(renderPart).not.toHaveBeenCalled();
  });

  it('routes a task part without handlers to TaskToolCard', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartRenderer({ part: makeToolPart('task', taskCompletedState) });
    expect(findByType(root, TaskToolCard)).toHaveLength(1);
  });

  it('passes modelOptions through to ChildSessionSection for a task part', () => {
    const childMessage = makeStoredMessage();
    const getChildMessages = vi.fn((id: string) => (id === 'child-1' ? [childMessage] : []));
    const renderPart = vi.fn();
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();
    const part = makeToolPart('task', taskCompletedState);

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ToolPartRenderer({
      part,
      getChildMessages,
      renderPart,
      onOpenChildSession,
      modelOptions,
    });

    const sections = findByType(root, ChildSessionSection);
    expect(sections).toHaveLength(1);
    const section = sections[0];
    if (!section) {
      throw new Error('expected ChildSessionSection');
    }
    expect(section.props).toMatchObject({ modelOptions });
  });
});
