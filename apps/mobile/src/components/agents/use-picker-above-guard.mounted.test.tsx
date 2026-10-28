import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePickerAboveLeaveGuard } from './use-picker-above-guard';

const backMock = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
  state: { index: 1, routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/new' }] },
}));
const stateListeners = vi.hoisted(() => new Set<() => void>());
const preventRemove = vi.hoisted(() => ({
  prevent: false,
  handler: null as
    | null
    | ((options: { data: { action: { type: string } }; repeat: () => void }) => void),
}));

vi.mock('expo-router', () => {
  const navigation = {
    getState: () => navigationState.state,
    addListener: (_event: string, listener: () => void) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
  return {
    useNavigation: () => navigation,
    useRouter: () => ({ back: backMock }),
    usePreventRemove: (
      prevent: boolean,
      handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
    ) => {
      preventRemove.prevent = prevent;
      preventRemove.handler = handler;
    },
  };
});

function Harness() {
  usePickerAboveLeaveGuard();
  return null;
}

function mountGuard(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  if (!ref.current) {
    throw new Error('the guard did not mount');
  }
  return ref.current;
}

function fireLeave(actionType: string): () => void {
  const repeat = vi.fn<() => void>();
  const handler = preventRemove.handler;
  if (!handler) {
    throw new Error('the guard did not arm');
  }
  act(() => {
    handler({ data: { action: { type: actionType } }, repeat });
  });
  return repeat;
}

describe('usePickerAboveLeaveGuard', () => {
  beforeEach(() => {
    backMock.mockClear();
    stateListeners.clear();
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/new' }],
    };
  });

  it('leaves ordinary session Back navigation unguarded', () => {
    const renderer = mountGuard();

    expect(preventRemove.prevent).toBe(false);
    renderer.unmount();
  });

  it('closes the picker instead of the screen under it', () => {
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/repo-picker' }],
    };
    mountGuard();

    const repeat = fireLeave('GO_BACK');

    expect(backMock).toHaveBeenCalledTimes(1);
    expect(repeat).not.toHaveBeenCalled();
  });

  it('closes the picker for the iOS swipe-back action too', () => {
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/instance-picker' }],
    };
    mountGuard();

    const repeat = fireLeave('POP');

    expect(backMock).toHaveBeenCalledTimes(1);
    expect(repeat).not.toHaveBeenCalled();
  });

  it('replays an already queued Back after the picker has closed', () => {
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/model-picker' }],
    };
    mountGuard();
    navigationState.state = {
      index: 0,
      routes: [{ name: 'agent-chat/new' }],
    };

    const repeat = fireLeave('GO_BACK');

    expect(backMock).not.toHaveBeenCalled();
    expect(repeat).toHaveBeenCalledTimes(1);
  });

  it('replays a forward removal that happens while a picker is above', () => {
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/model-picker' }],
    };
    mountGuard();

    const repeat = fireLeave('NAVIGATE');

    expect(backMock).not.toHaveBeenCalled();
    expect(repeat).toHaveBeenCalledTimes(1);
  });

  it('disables prevention before replaying a forward removal', () => {
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/model-picker' }],
    };
    const renderer = mountGuard();
    expect(preventRemove.prevent).toBe(true);

    fireLeave('NAVIGATE');

    expect(preventRemove.prevent).toBe(false);
    renderer.unmount();
  });

  it('arms and clears protection when the stack changes without rerendering its screen', () => {
    const renderer = mountGuard();
    navigationState.state = {
      index: 2,
      routes: [
        { name: 'agent-chat/new' },
        { name: 'agent-chat/new' },
        { name: 'agent-chat/branch-picker' },
      ],
    };
    act(() => {
      for (const listener of stateListeners) {
        listener();
      }
    });
    expect(preventRemove.prevent).toBe(true);

    const repeat = fireLeave('GO_BACK');

    expect(backMock).toHaveBeenCalledTimes(1);
    expect(repeat).not.toHaveBeenCalled();
    navigationState.state = {
      index: 1,
      routes: [{ name: 'agent-chat/new' }, { name: 'agent-chat/new' }],
    };
    act(() => {
      for (const listener of stateListeners) {
        listener();
      }
    });
    expect(preventRemove.prevent).toBe(false);
    renderer.unmount();
  });
});
