import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PickerLaunchRestoreMount } from './picker-launch-restore-mount';

const state = vi.hoisted(() => ({
  userId: 'user-1' as string | undefined,
  segments: ['(app)', '(tabs)', '(0_home)'] as string[],
}));

const routerNavigate = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: new Set<(next: string) => void>(),
}));
const readPickerRestoreRecord = vi.hoisted(() => vi.fn());
const clearPickerRestoreRecord = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: routerNavigate }),
  useSegments: () => state.segments,
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState(): string {
      return appState.currentState;
    },
    // eslint-disable-next-line prefer-await-to-callbacks -- addEventListener is inherently callback-based
    addEventListener: (_event: string, listener: (next: string) => void) => {
      appState.listeners.add(listener);
      return {
        remove: () => {
          appState.listeners.delete(listener);
        },
      };
    },
  },
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: state.userId }),
}));

vi.mock('@/lib/agent-attachments/picker-launch-context', () => ({
  // The restore reads the shared recovery window from this module.
  PICKER_LAUNCH_CONTEXT_TTL_MS: 10 * 60 * 1000,
  readPickerRestoreRecord,
  clearPickerRestoreRecord,
}));

function launchContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    surface: 'agent-new',
    sessionId: null,
    organizationId: null,
    launchedAt: Date.now(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(PickerLaunchRestoreMount));
    await settle();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** Re-render the same root, the way a new account id or route arrives. */
async function rerender(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(createElement(PickerLaunchRestoreMount));
    await settle();
  });
}

async function emitAppState(next: string): Promise<void> {
  appState.currentState = next;
  await act(async () => {
    for (const listener of appState.listeners) {
      listener(next);
    }
    await settle();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.userId = 'user-1';
  state.segments = ['(app)', '(tabs)', '(0_home)'];
  appState.currentState = 'active';
  appState.listeners.clear();
  readPickerRestoreRecord.mockResolvedValue(launchContext());
});

describe('PickerLaunchRestoreMount', () => {
  it('reopens the new-session composer when the app starts back in the foreground', async () => {
    readPickerRestoreRecord.mockResolvedValue(launchContext({ organizationId: 'org_123' }));

    await mount();

    expect(routerNavigate).toHaveBeenCalledTimes(1);
    expect(routerNavigate).toHaveBeenCalledWith('/(app)/agent-chat/new?organizationId=org_123');
    // The decision is taken once per start, so the record cannot reopen the
    // composer again on a later start.
    expect(clearPickerRestoreRecord).toHaveBeenCalledTimes(1);
  });

  it('reopens the session composer that launched the picker', async () => {
    readPickerRestoreRecord.mockResolvedValue(
      launchContext({ surface: 'agent-chat', sessionId: 'ses_0123456789abcdef0123456789' })
    );

    await mount();

    expect(routerNavigate).toHaveBeenCalledTimes(1);
    expect(routerNavigate).toHaveBeenCalledWith('/(app)/agent-chat/ses_0123456789abcdef0123456789');
  });

  it('reopens it only on the way back to the foreground when the picker is still in front', async () => {
    appState.currentState = 'background';

    await mount();

    expect(routerNavigate).not.toHaveBeenCalled();

    await emitAppState('active');

    expect(routerNavigate).toHaveBeenCalledTimes(1);
    expect(routerNavigate).toHaveBeenCalledWith('/(app)/agent-chat/new');

    // A later activation does not open a second composer.
    await emitAppState('background');
    await emitAppState('active');
    expect(routerNavigate).toHaveBeenCalledTimes(1);
  });

  it('waits for the account before deciding', async () => {
    state.userId = undefined;
    const renderer = await mount();

    expect(readPickerRestoreRecord).not.toHaveBeenCalled();
    expect(routerNavigate).not.toHaveBeenCalled();

    state.userId = 'user-1';
    await rerender(renderer);

    expect(routerNavigate).toHaveBeenCalledTimes(1);
  });

  it('leaves a route the app was sent to alone', async () => {
    state.segments = ['(app)', '(tabs)', '(2_agents)'];

    await mount();

    expect(routerNavigate).not.toHaveBeenCalled();
    // Declining still retires the record: the start decided.
    expect(clearPickerRestoreRecord).toHaveBeenCalledTimes(1);
  });

  it('ignores another account’s launch', async () => {
    readPickerRestoreRecord.mockResolvedValue(launchContext({ userId: 'user-2' }));

    await mount();

    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('ignores a launch older than the recovery window', async () => {
    readPickerRestoreRecord.mockResolvedValue(
      launchContext({ launchedAt: Date.now() - 11 * 60 * 1000 })
    );

    await mount();

    expect(routerNavigate).not.toHaveBeenCalled();
  });
});
