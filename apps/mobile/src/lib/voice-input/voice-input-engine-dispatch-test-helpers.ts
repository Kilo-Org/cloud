/* eslint-disable require-await, @typescript-eslint/require-await -- the fake engines resolve immediately, so they settle without await */
import { type Mock, vi } from 'vitest';

import {
  type VoiceInputNative,
  type VoiceInputNativeEvent,
  type VoiceInputNativePermission,
  type VoiceInputNativeStartOptions,
} from './voice-input-controller';
import { createDispatchingVoiceInputNative } from './voice-input-engine-dispatch';
import { resolveVoiceInputEngineMode } from './voice-input-engine-mode';

export type FakeNative = VoiceInputNative & {
  calls: string[];
  lastStartOptions: VoiceInputNativeStartOptions | null;
  emit(event: keyof VoiceInputNativeEvent, payload: unknown): void;
  listenerCount(event: keyof VoiceInputNativeEvent): number;
};

export const START_OPTIONS: VoiceInputNativeStartOptions = {
  continuous: false,
  interimResults: true,
  lang: 'en-US',
  maxAlternatives: 1,
  requiresOnDeviceRecognition: false,
};

export const DENIED: VoiceInputNativePermission = { granted: false, canAskAgain: false };
export const GRANTED: VoiceInputNativePermission = { granted: true, canAskAgain: true };

export function makeResult(transcript: string): VoiceInputNativeEvent['result'] {
  return { isFinal: true, results: [{ transcript, confidence: 1, segments: [] }] };
}

export function createFakeNative(
  name: string,
  available: boolean,
  permission: VoiceInputNativePermission = GRANTED
): FakeNative {
  const calls: string[] = [];
  const listeners = new Map<keyof VoiceInputNativeEvent, Set<Mock>>();
  let lastStartOptions: VoiceInputNativeStartOptions | null = null;
  return {
    calls,
    get lastStartOptions() {
      return lastStartOptions;
    },
    addListener(event, listener) {
      calls.push(`addListener:${event}`);
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const boxed = listener as unknown as Mock;
      set.add(boxed);
      return {
        remove: (): void => {
          calls.push(`remove:${event}`);
          listeners.get(event)?.delete(boxed);
        },
      };
    },
    getPermissions: vi.fn(async () => {
      calls.push('getPermissions');
      return permission;
    }),
    requestPermissions: vi.fn(async () => {
      calls.push('requestPermissions');
      return permission;
    }),
    isRecognitionAvailable: vi.fn(() => {
      calls.push('isRecognitionAvailable');
      return available;
    }),
    supportsContinuousRecognition: vi.fn(() => {
      calls.push('supportsContinuousRecognition');
      return name === 'os';
    }),
    supportsOnDevice: vi.fn(() => {
      calls.push('supportsOnDevice');
      return name === 'os';
    }),
    start: vi.fn((options: VoiceInputNativeStartOptions) => {
      lastStartOptions = options;
      calls.push(`start:${options.lang}`);
    }),
    stop: vi.fn(() => {
      calls.push('stop');
    }),
    abort: vi.fn(() => {
      calls.push('abort');
    }),
    emit(event, payload): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    listenerCount(event): number {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

export function build(
  enabled: boolean,
  primary = true,
  osAvailable = true
): {
  dispatch: VoiceInputNative;
  gateway: FakeNative;
  os: FakeNative;
  setEnabled: (value: boolean) => void;
  setPrimary: (value: boolean) => void;
} {
  let isEnabled = enabled;
  let isPrimary = primary;
  const os = createFakeNative('os', osAvailable);
  const gateway = createFakeNative('gateway', true);
  const dispatch = createDispatchingVoiceInputNative(os, gateway, () =>
    resolveVoiceInputEngineMode(isEnabled, isPrimary)
  );
  return {
    dispatch,
    gateway,
    os,
    setEnabled: (value: boolean): void => {
      isEnabled = value;
    },
    setPrimary: (value: boolean): void => {
      isPrimary = value;
    },
  };
}

export function buildWithPermissions(config: {
  enabled: boolean;
  primary: boolean;
  osPermission: VoiceInputNativePermission;
  gatewayPermission: VoiceInputNativePermission;
}): { dispatch: VoiceInputNative; gateway: FakeNative; os: FakeNative } {
  const os = createFakeNative('os', true, config.osPermission);
  const gateway = createFakeNative('gateway', true, config.gatewayPermission);
  const dispatch = createDispatchingVoiceInputNative(os, gateway, () =>
    resolveVoiceInputEngineMode(config.enabled, config.primary)
  );
  return { dispatch, gateway, os };
}

export function recordEvents(dispatch: VoiceInputNative): {
  errors: VoiceInputNativeEvent['error'][];
  ends: number;
  results: VoiceInputNativeEvent['result'][];
  fellBacks: VoiceInputNativeEvent['engine-fell-back'][];
} {
  const errors: VoiceInputNativeEvent['error'][] = [];
  const results: VoiceInputNativeEvent['result'][] = [];
  const fellBacks: VoiceInputNativeEvent['engine-fell-back'][] = [];
  const state = { ends: 0 };
  dispatch.addListener('error', event => {
    errors.push(event);
  });
  dispatch.addListener('result', event => {
    results.push(event);
  });
  dispatch.addListener('engine-fell-back', event => {
    fellBacks.push(event);
  });
  dispatch.addListener('end', () => {
    state.ends += 1;
  });
  return {
    errors,
    results,
    fellBacks,
    get ends() {
      return state.ends;
    },
  };
}

/** Session-driving calls only: probes and listener plumbing are allowed while the gateway switch is on. */
export function sessionCalls(engine: FakeNative): string[] {
  return engine.calls.filter(call => /^(start:|stop$|abort$)/.test(call));
}

/**
 * Let the fallback permission continuation run: the dispatcher starts the
 * fallback engine only after its async permission request resolves, and a
 * settled macrotask flushes that continuation.
 */
export async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
