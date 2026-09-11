/* eslint-disable require-await, @typescript-eslint/require-await -- the fake engines resolve immediately, so they settle without await */
import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type VoiceInputNative,
  type VoiceInputNativeEvent,
  type VoiceInputNativePermission,
  type VoiceInputNativeStartOptions,
} from './voice-input-controller';
import { createSelectingVoiceInputNative } from './voice-input-engine-select';
import { type VoiceInputEngineName } from './voice-input-engine-mode';

const START_OPTIONS: VoiceInputNativeStartOptions = {
  continuous: false,
  interimResults: true,
  lang: 'en-US',
  maxAlternatives: 1,
  requiresOnDeviceRecognition: false,
};

const GRANTED: VoiceInputNativePermission = { granted: true, canAskAgain: true };

type FakeNative = VoiceInputNative & {
  calls: string[];
  emit(event: keyof VoiceInputNativeEvent, payload: unknown): void;
};

function makeEngine(
  name: VoiceInputEngineName,
  permission: VoiceInputNativePermission = GRANTED
): FakeNative {
  const calls: string[] = [];
  const listeners = new Map<keyof VoiceInputNativeEvent, Set<Mock>>();
  return {
    calls,
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
      return true;
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
  };
}

function build(initial: VoiceInputEngineName) {
  let engine = initial;
  const os = makeEngine('os');
  const gateway = makeEngine('gateway');
  const native = createSelectingVoiceInputNative({ os, gateway }, () => engine);
  return {
    native,
    os,
    gateway,
    setEngine: (next: VoiceInputEngineName): void => {
      engine = next;
    },
  };
}

function sessionCalls(engine: FakeNative): string[] {
  return engine.calls.filter(call => /^(start:|stop$|abort$)/.test(call));
}

describe('createSelectingVoiceInputNative', () => {
  it('starts only the device engine in device mode', () => {
    const { native, os, gateway } = build('os');
    native.start(START_OPTIONS);

    expect(sessionCalls(os)).toEqual(['start:en-US']);
    expect(sessionCalls(gateway)).toEqual([]);
    // No gateway listener is attached either: device mode never touches it.
    expect(gateway.calls).toEqual([]);
  });

  it('starts only the gateway engine in gateway mode', () => {
    const { native, os, gateway } = build('gateway');
    native.start(START_OPTIONS);

    expect(sessionCalls(gateway)).toEqual(['start:en-US']);
    expect(sessionCalls(os)).toEqual([]);
    expect(os.calls).toEqual([]);
  });

  it('routes stop and abort to the engine that owns the session', () => {
    const { native, os, gateway } = build('gateway');
    native.start(START_OPTIONS);

    native.stop();
    native.abort();

    expect(sessionCalls(gateway)).toEqual(['start:en-US', 'stop', 'abort']);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('forwards events from the active engine and drops the idle engine', () => {
    const { native, os, gateway } = build('gateway');
    const seen: string[] = [];
    native.addListener('result', event => {
      seen.push(event.results[0]?.transcript ?? '');
    });
    native.addListener('end', () => {
      seen.push('end');
    });

    native.start(START_OPTIONS);
    os.emit('result', {
      isFinal: true,
      results: [{ transcript: 'idle', confidence: 1, segments: [] }],
    });
    gateway.emit('result', {
      isFinal: true,
      results: [{ transcript: 'active', confidence: 1, segments: [] }],
    });
    gateway.emit('end', null);

    expect(seen).toEqual(['active', 'end']);
  });

  it('keeps the session on the engine chosen at start when the preference flips mid-session', () => {
    const { native, os, gateway, setEngine } = build('os');
    native.start(START_OPTIONS);
    setEngine('gateway');

    native.stop();
    os.emit('end', null);

    expect(sessionCalls(os)).toEqual(['start:en-US', 'stop']);
    expect(sessionCalls(gateway)).toEqual([]);
  });

  it('probes permissions, availability and capabilities on the chosen engine', async () => {
    const { native, os, gateway, setEngine } = build('gateway');

    await native.getPermissions();
    await native.requestPermissions();
    native.isRecognitionAvailable();
    native.supportsContinuousRecognition();
    native.supportsOnDevice();

    expect(gateway.calls).toEqual([
      'getPermissions',
      'requestPermissions',
      'isRecognitionAvailable',
      'supportsContinuousRecognition',
      'supportsOnDevice',
    ]);
    expect(os.calls).toEqual([]);

    setEngine('os');
    await native.getPermissions();
    expect(os.calls).toEqual(['getPermissions']);
  });

  it('reuses one session slot: a second start replaces the first engine subscription', () => {
    const { native, os, gateway } = build('os');
    native.start(START_OPTIONS);
    native.start(START_OPTIONS);

    // The first session's listeners are removed before the second attaches.
    expect(sessionCalls(os)).toEqual(['start:en-US', 'start:en-US']);
    expect(sessionCalls(gateway)).toEqual([]);
  });
});
