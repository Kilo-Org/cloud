import {
  type Part,
  type StoredMessage,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChildSessionMessage, ChildSessionSection } from './child-session-section';
import { MessageErrorBoundary } from './message-error-boundary';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  ChevronRight: 'ChevronRight',
  Loader2: 'Loader2',
}));
vi.mock('@/components/ui/spinning-icon', () => ({
  SpinningIcon: 'SpinningIcon',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));
vi.mock('./message-error-boundary', () => ({
  MessageErrorBoundary: ({ children }: { children?: unknown }) => children,
}));

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

function makeTextPart(text: string): TextPart {
  return { id: 't1', sessionID: 's1', messageID: 'm1', type: 'text', text };
}

function makeMessage(parts: Part[]): StoredMessage {
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
    parts,
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

function findByType(node: unknown, type: React.ElementType): React.ReactElement[] {
  return findAll(node, el => el.type === type);
}

const textChildren = (el: React.ReactElement): unknown =>
  (el.props as { children?: unknown }).children;

describe('ChildSessionMessage routing seam', () => {
  it('renders a task part directly through ChildSessionSection, never through renderPart', () => {
    const childMessages = [makeMessage([makeTextPart('child text')])];
    const getChildMessages = vi.fn((id: string) => (id === 'child-1' ? childMessages : []));
    const renderPart = vi.fn();
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ChildSessionMessage({
      message: makeMessage([makeToolPart('task', taskCompletedState)]),
      depth: 0,
      getChildMessages,
      renderPart,
      onOpenChildSession,
    });

    expect(getChildMessages).toHaveBeenCalledWith('child-1');
    expect(renderPart).not.toHaveBeenCalled();
    const sections = findByType(root, ChildSessionSection);
    expect(sections).toHaveLength(1);
    const section = sections[0];
    if (!section) {
      throw new Error('expected ChildSessionSection');
    }
    expect(section.props).toMatchObject({
      part: expect.objectContaining({ id: 'task-1', tool: 'task' }),
      childMessages,
      onOpenChildSession,
    });
  });

  it('routes non-task parts through renderPart inside MessageErrorBoundary', () => {
    const getChildMessages = vi.fn<() => StoredMessage[]>(() => []);
    const renderPart = vi.fn(() => null);
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();
    const part = makeTextPart('hello');

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ChildSessionMessage({
      message: makeMessage([part]),
      depth: 0,
      getChildMessages,
      renderPart,
      onOpenChildSession,
    });

    expect(renderPart).toHaveBeenCalledTimes(1);
    expect(renderPart).toHaveBeenCalledWith(
      expect.objectContaining({ part, getChildMessages, onOpenChildSession })
    );
    expect(findByType(root, MessageErrorBoundary)).toHaveLength(1);
  });

  it('mixes direct child-session rendering with renderPart for sibling parts', () => {
    const getChildMessages = vi.fn<() => StoredMessage[]>(() => []);
    const renderPart = vi.fn(() => null);
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ChildSessionMessage({
      message: makeMessage([makeToolPart('task', taskCompletedState), makeTextPart('after')]),
      depth: 0,
      getChildMessages,
      renderPart,
      onOpenChildSession,
    });

    expect(findByType(root, ChildSessionSection)).toHaveLength(1);
    expect(renderPart).toHaveBeenCalledTimes(1);
    expect(renderPart).toHaveBeenCalledWith(
      expect.objectContaining({ part: expect.objectContaining({ id: 't1', type: 'text' }) })
    );
  });

  it('renders the nesting-depth limit text at the depth cap', () => {
    const getChildMessages = vi.fn<() => StoredMessage[]>(() => []);
    const renderPart = vi.fn();
    const onOpenChildSession = vi.fn<(sessionId: string, title: string) => void>();

    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ChildSessionMessage({
      message: makeMessage([makeTextPart('deep')]),
      depth: 5,
      getChildMessages,
      renderPart,
      onOpenChildSession,
    });

    const limitTexts = findAll(
      root,
      el => el.type === 'Text' && textChildren(el) === 'Maximum nesting depth reached.'
    );
    expect(limitTexts).toHaveLength(1);
    expect(renderPart).not.toHaveBeenCalled();
  });
});
