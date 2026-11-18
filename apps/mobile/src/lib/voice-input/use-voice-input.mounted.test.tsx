import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type VoiceInputControllerSnapshot } from './voice-input-controller';
import { useVoiceInput } from './use-voice-input';

const state = vi.hoisted(() => ({
  appStateListeners: [] as ((next: string) => void)[],
}));

const controllerMock = vi.hoisted(() => {
  // One object: useSyncExternalStore compares snapshot identity, so a fresh
  // object per read would loop forever.
  const snapshot: VoiceInputControllerSnapshot = {
    availability: 'available',
    owner: null,
    status: 'idle',
  };
  return {
    abort: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getSnapshot: vi.fn<() => VoiceInputControllerSnapshot>(() => snapshot),
    refreshAvailability: vi.fn<() => void>(),
    start: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    stop: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    subscribe: vi.fn<(listener: () => void) => () => void>(() => () => undefined),
    supportsOnDevice: vi.fn<() => boolean>(() => false),
  };
});

const routerMock = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));

const actionsMock = vi.hoisted(() => ({
  /** What the hook handed to `createVoiceInputActions`, for the navigation cases. */
  config: undefined as { openTranscriptionModelPicker: () => void } | undefined,
}));

vi.mock('expo-router', () => ({ useRouter: () => routerMock }));

vi.mock('./native-voice-input', () => ({ voiceInputController: controllerMock }));

vi.mock('./use-voice-input-actions', () => ({
  createVoiceInputActions: (config: { openTranscriptionModelPicker: () => void }) => {
    actionsMock.config = config;
    return {
      abort: () => Promise.resolve(true),
      settleBeforeSubmit: () => Promise.resolve(true),
      toggle: () => Promise.resolve(),
    };
  },
  publishVoiceInputFeedback: vi.fn(),
  readVoiceInputFeedback: () => null,
  runVoiceInputListeningFeedback: vi.fn(),
  shouldAbortVoiceInputForOwner: () => false,
  subscribeVoiceInputFeedback: () => () => undefined,
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));

vi.mock('./voice-input-language-preference', () => ({
  useVoiceInputLanguage: () => 'en-US',
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.appStateListeners.push(listener);
      return { remove: () => undefined };
    },
  },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
}));

function Probe(): null {
  useVoiceInput({
    disabled: false,
    getDraft: () => '',
    onDraftChange: () => undefined,
  });
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

async function render(): Promise<void> {
  await act(() => {
    renderer = TestRenderer.create(createElement(Probe));
    return Promise.resolve();
  });
}

describe('useVoiceInput availability probe', () => {
  beforeEach(() => {
    state.appStateListeners = [];
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.clearAllMocks();
  });

  it('re-reads recognizer availability when a surface mounts', async () => {
    await render();

    expect(controllerMock.refreshAvailability).toHaveBeenCalledTimes(1);
  });

  it('re-reads it when the app returns to the foreground, not when it leaves', async () => {
    await render();
    controllerMock.refreshAvailability.mockClear();

    const [listener] = state.appStateListeners;
    if (!listener) {
      throw new Error('AppState listener was not registered');
    }
    act(() => {
      listener('background');
    });
    expect(controllerMock.refreshAvailability).not.toHaveBeenCalled();

    act(() => {
      listener('active');
    });
    expect(controllerMock.refreshAvailability).toHaveBeenCalledTimes(1);
  });
});

describe('useVoiceInput model-picker navigation', () => {
  beforeEach(() => {
    state.appStateListeners = [];
    actionsMock.config = undefined;
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.clearAllMocks();
  });

  it('opens the picker through the router of the surface that owns the feedback', async () => {
    await render();

    actionsMock.config?.openTranscriptionModelPicker();

    expect(routerMock.push).toHaveBeenCalledWith('/(app)/transcription-model-picker');
  });

  it('opens nothing once the owner is gone and its alert is still on screen', async () => {
    await render();
    const action = actionsMock.config?.openTranscriptionModelPicker;
    if (!action) {
      throw new Error('the hook did not supply a navigation action');
    }

    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;

    action();

    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
