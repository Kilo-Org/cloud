/* eslint-disable max-lines -- routing fixtures and the shared status/part matrix cover both card entry points */
import { type Part, type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import * as React from 'react';
import { type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';

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
import { ChildSessionMessage, ChildSessionSection } from './child-session-section';
import { getChildSessionActivityLabel, getChildSessionCardState } from './child-session-card-state';
import { ToolPartRenderer } from './tool-part-renderer';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('@/components/ui/icons', () => ({ Bot: 'Bot', Loader2: 'Loader2' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('./message-error-boundary', () => ({ MessageErrorBoundary: 'MessageErrorBoundary' }));
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

function makeStoredMessage(parts: Part[] = []): StoredMessage {
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

function makeTaskState(status: ToolPart['state']['status']): ToolPart['state'] {
  const input = taskCompletedState.input;
  const metadata = taskCompletedState.metadata;
  if (status === 'pending') {
    return { status, input, raw: '' };
  }
  if (status === 'running') {
    return { status, input, metadata, time: { start: 1 } };
  }
  if (status === 'error') {
    return { status, input, metadata, error: 'failed', time: { start: 1, end: 2 } };
  }
  return taskCompletedState;
}

// eslint-disable-next-line typescript-eslint/no-deprecated -- the existing harness uses this DOM-free React renderer
function textContent(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textContent).join('');
}

const childPartBase = { id: 'activity', sessionID: 'child-1', messageID: 'child-message' };
const textPart: Part = { ...childPartBase, type: 'text', text: 'The answer' };
const activityParts: [string, Part, string][] = [
  ['text', textPart, 'Writing response'],
  [
    'reasoning',
    { ...childPartBase, type: 'reasoning', text: 'Thinking', time: { start: 1 } },
    'Thinking',
  ],
  [
    'snapshot progress',
    { ...childPartBase, type: 'text', text: 'Initializing snapshot…', synthetic: true },
    'Initializing snapshot…',
  ],
  ['step start', { ...childPartBase, type: 'step-start' }, 'Considering next steps'],
  [
    'step finish',
    {
      ...childPartBase,
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    'Considering next steps',
  ],
];
const toolActivities: [string, Record<string, unknown>, string][] = [
  ['read', { filePath: '/project/spec.md' }, 'read spec.md'],
  ['edit', { filePath: '/project/spec.md' }, 'edit spec.md'],
  ['write', { filePath: '/project/spec.md' }, 'write spec.md'],
  ['bash', { command: 'pnpm test' }, 'bash pnpm'],
  ['glob', { pattern: '**/*.ts' }, 'glob **/*.ts'],
  ['grep', { pattern: 'handler' }, 'grep handler'],
  ['task', { description: 'Nested work' }, 'task Nested work'],
  ...[
    'list',
    'patch',
    'apply_patch',
    'websearch',
    'webfetch',
    'codesearch',
    'todoread',
    'todowrite',
    'question',
    'suggest',
    'plan_enter',
    'plan_exit',
    'unknown-tool',
  ].map(tool => [tool, {}, tool] satisfies [string, Record<string, unknown>, string]),
];
const activityHistories: [string, StoredMessage[], string][] = [
  ['empty history', [], 'Waiting for activity'],
  ['incomplete history', [makeStoredMessage()], 'Waiting for activity'],
  [
    'delayed latest parts',
    [makeStoredMessage([textPart]), makeStoredMessage()],
    'Writing response',
  ],
  ...activityParts.map(
    ([name, part, activity]) =>
      [name, [makeStoredMessage([part])], activity] satisfies [string, StoredMessage[], string]
  ),
  ...toolActivities.flatMap(([tool, input, activity]) =>
    (['pending', 'running', 'completed', 'error'] as const).map(
      status =>
        [
          `${status} ${tool}`,
          [makeStoredMessage([makeToolPart(tool, { ...makeTaskState(status), input })])],
          activity,
        ] satisfies [string, StoredMessage[], string]
    )
  ),
];

// One executable matrix checks the projection and both production entry points.
describe.each(['top-level', 'nested'] as const)('%s child-card initial history', entry => {
  describe.each([
    { status: 'pending', active: true, canOpen: false },
    { status: 'running', active: true, canOpen: true },
    { status: 'completed', active: false, canOpen: true },
    { status: 'error', active: false, canOpen: true },
  ] as const)('$status parent', ({ status, active, canOpen }) => {
    it.each(activityHistories)(
      'keeps activity and child access consistent for %s',
      async (_name, messages, activity) => {
        const part = makeToolPart('task', makeTaskState(status));
        const childMessages = canOpen ? messages : [];
        const activeActivity = canOpen ? activity : 'Waiting for activity';
        const expectedActivity = active ? activeActivity : '';
        const modelLabel = childMessages.length > 0 ? 'Test Model' : '';
        const projected = getChildSessionCardState(part, childMessages);
        expect(getChildSessionActivityLabel(projected.latestActivity)).toBe(expectedActivity);

        const openedChildren: [string, string][] = [];
        const props = {
          getChildMessages: (id: string) => (id === 'child-1' ? messages : []),
          renderPart: () => null,
          onOpenChildSession: (id: string, title: string) => {
            openedChildren.push([id, title]);
          },
          modelOptions,
        };
        const element =
          entry === 'top-level'
            ? React.createElement(ToolPartRenderer, { ...props, part })
            : React.createElement(ChildSessionMessage, {
                ...props,
                message: makeStoredMessage([part]),
                depth: 1,
              });
        const { renderer, unmount } = await renderWithProviders(element);
        try {
          expect(textContent(renderer.root)).toBe(
            `Generalchild task${modelLabel}${expectedActivity}${status}`
          );
          expect(renderer.root.findAll(node => node.type === 'SpinningIcon')).toHaveLength(
            active ? 1 : 0
          );
          const button = renderer.root.findByType('Pressable');
          expect(button.props.accessibilityRole).toBe('button');
          expect(button.props.accessibilityLabel).toContain('General, child task');
          expect(button.props.accessibilityLabel).toContain(status);
          if (modelLabel) {
            expect(button.props.accessibilityLabel).toContain(modelLabel);
          }
          if (active) {
            expect(button.props.accessibilityLabel).toContain(expectedActivity);
          } else {
            expect(button.props.accessibilityLabel).not.toContain(activity);
            expect(renderer.root.findAll(node => node.type === 'Text')).toHaveLength(
              modelLabel ? 4 : 3
            );
          }
          expect(button.props.disabled).toBe(!canOpen);
          expect(button.props.accessibilityState).toEqual({ disabled: !canOpen });
          const { onPress } = button.props as { onPress: () => void };
          onPress();
          expect(openedChildren).toEqual(canOpen ? [['child-1', 'child task']] : []);
        } finally {
          unmount();
        }
      }
    );
  });
});

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
