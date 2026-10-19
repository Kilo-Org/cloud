import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStartTodo } from '@/components/todos/use-start-todo';

const state = vi.hoisted(() => ({
  push: vi.fn((_href: unknown) => undefined),
  focusEffects: [] as (() => void)[],
  now: 1_700_000_000_000,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: state.push }),
  useFocusEffect: (effect: () => void) => {
    state.focusEffects.push(effect);
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(), NotificationFeedbackType: {} }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({}) }));
// The to-do's "start now" path is not this suite's subject: only the
// review push (the composer entry) is exercised here.
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/lib/app-actions/start-agent', () => ({ startAgent: vi.fn() }));
vi.mock('@/lib/hooks/todo-session-link', () => ({ linkStartedTodoSession: vi.fn() }));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: vi.fn(),
}));

const TODO = { id: 'todo-1', title: 'Fix login', notes: null };
const LIST = {
  organizationId: 'org-1',
  gitUrl: 'octocat/hello',
  mode: 'code',
  model: 'kilo-auto/efficient',
  variant: null,
};

function Probe(): ReactElement {
  const { review } = useStartTodo();
  // A host element stands in for the row's Review control.
  return createElement('ReviewButton', {
    onPress: () => {
      review(TODO, LIST);
    },
  });
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function nodesOfType(type: string): TestRenderer.ReactTestInstance[] {
  return renderer === undefined
    ? []
    : renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The probe's press handler, narrowed once for the calls below. */
function pressHandler(): () => void {
  const handler: unknown = nodesOfType('ReviewButton')[0]?.props.onPress;
  if (typeof handler !== 'function') {
    throw new TypeError('Expected the probe to expose a Review press handler');
  }
  return handler as () => void;
}

async function doublePress(): Promise<void> {
  await act(async () => {
    const tap = pressHandler();
    tap();
    tap();
    await Promise.resolve();
  });
}

async function press(): Promise<void> {
  await act(async () => {
    pressHandler()();
    await Promise.resolve();
  });
}

async function regainFocus(): Promise<void> {
  await act(async () => {
    for (const effect of state.focusEffects) {
      effect();
    }
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.push.mockReset();
  state.focusEffects = [];
  state.now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => state.now);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

describe('useStartTodo review', () => {
  it('opens the prefilled composer', async () => {
    await mount();

    await press();

    const href = state.push.mock.calls[0]?.[0];
    expect(typeof href).toBe('string');
    expect(href).toContain('/(app)/agent-chat/new?organizationId=org-1');
    expect(href).toContain('prefillRepo=octocat%2Fhello');
    expect(href).toContain('todoId=todo-1');
    expect(state.push).toHaveBeenCalledTimes(1);
  });

  it('opens the composer once on a fast double tap', async () => {
    await mount();

    await doublePress();

    expect(state.push).toHaveBeenCalledTimes(1);
  });

  it('opens the composer again on a tap after the guard window', async () => {
    await mount();
    await press();

    state.now += 1000;
    await press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });

  it('opens the composer again after the screen regains focus', async () => {
    await mount();
    await doublePress();
    await regainFocus();

    await press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });
});
