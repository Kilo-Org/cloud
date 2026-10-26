import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionListFab } from '@/components/agents/session-list-fab';

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
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/icons', () => ({ Plus: 'Plus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#FFFFFF' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function nodesOfType(type: string): TestRenderer.ReactTestInstance[] {
  return renderer === undefined
    ? []
    : renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function fab(): TestRenderer.ReactTestInstance {
  const nodes = nodesOfType('Pressable');
  const node = nodes[0];
  if (nodes.length !== 1 || !node) {
    throw new Error(`Expected one New session action, received ${nodes.length}`);
  }
  return node;
}

/** The action's press handler, narrowed once for the calls below. */
function pressHandler(): () => void {
  const handler: unknown = fab().props.onPress;
  if (typeof handler !== 'function') {
    throw new TypeError('Expected the New session action to carry a press handler');
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

async function mount(organizationId: string | null = null): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(SessionListFab, { organizationId, style: undefined })
    );
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

describe('SessionListFab', () => {
  it('opens the personal composer once', async () => {
    await mount();

    await press();

    expect(state.push).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/new');
  });

  it('carries the organization context into the composer route', async () => {
    await mount('org-1');

    await press();

    expect(state.push).toHaveBeenCalledExactlyOnceWith(
      '/(app)/agent-chat/new?organizationId=org-1'
    );
  });

  it('pushes once on a fast double tap', async () => {
    await mount('org-1');

    await doublePress();

    expect(state.push).toHaveBeenCalledExactlyOnceWith(
      '/(app)/agent-chat/new?organizationId=org-1'
    );
  });

  it('pushes again on a tap after the guard window', async () => {
    await mount();
    await press();

    state.now += 1000;
    await press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });

  it('pushes again after the screen regains focus', async () => {
    await mount();
    await doublePress();
    await regainFocus();

    await press();

    expect(state.push).toHaveBeenCalledTimes(2);
  });
});
