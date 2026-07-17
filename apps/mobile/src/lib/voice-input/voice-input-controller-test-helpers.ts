import { type ExpoSpeechRecognitionResult } from 'expo-speech-recognition';
import { type Mock, vi } from 'vitest';

import {
  type VoiceInputNative,
  type VoiceInputNativeEvent,
  type VoiceInputNativePermission,
  type VoiceInputNativeStartOptions,
  type VoiceInputStartOptions,
} from './voice-input-controller';

type AnyListener = (event: VoiceInputNativeEvent[keyof VoiceInputNativeEvent]) => void;

export type VoiceInputNativeControls = {
  isAvailable: boolean;
  supportsContinuous: boolean;
  permissionGranted: boolean;
  permissionCanAskAgain: boolean;
  permissionRestricted: boolean;
};

export type VoiceInputNativeMocks = {
  abort: Mock<() => void>;
  getPermissions: Mock<() => Promise<VoiceInputNativePermission>>;
  requestPermissions: Mock<() => Promise<VoiceInputNativePermission>>;
  start: Mock<(options: VoiceInputNativeStartOptions) => void>;
  stop: Mock<() => void>;
};

export type VoiceInputNativeHarness = {
  controls: VoiceInputNativeControls;
  mocks: VoiceInputNativeMocks;
  emit(
    event: keyof VoiceInputNativeEvent,
    payload: VoiceInputNativeEvent[keyof VoiceInputNativeEvent]
  ): void;
  emitResult(transcript: string, isFinal: boolean): void;
  listenerCount(event: keyof VoiceInputNativeEvent): number;
  native: VoiceInputNative;
};

function emptyResult(transcript: string): ExpoSpeechRecognitionResult {
  return {
    transcript,
    confidence: 0,
    segments: [],
  };
}

function buildNative(
  controls: VoiceInputNativeControls,
  mocks: VoiceInputNativeMocks,
  listeners: Map<keyof VoiceInputNativeEvent, Set<AnyListener>>
): VoiceInputNative {
  const addListener: VoiceInputNative['addListener'] = (event, listener) => {
    const boxed = listener as AnyListener;
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(boxed);
    return {
      remove: (): void => {
        const current = listeners.get(event);
        if (current) {
          current.delete(boxed);
        }
      },
    };
  };

  return {
    addListener,
    getPermissions: async () => {
      const result = await mocks.getPermissions();
      return result;
    },
    requestPermissions: async () => {
      const result = await mocks.requestPermissions();
      return result;
    },
    isRecognitionAvailable: () => controls.isAvailable,
    supportsContinuousRecognition: () => controls.supportsContinuous,
    start: (options): void => {
      mocks.start(options);
    },
    stop: (): void => {
      mocks.stop();
    },
    abort: (): void => {
      mocks.abort();
    },
  };
}

export function createVoiceInputNativeHarness(
  overrides: Partial<VoiceInputNativeControls> = {}
): VoiceInputNativeHarness {
  const controls: VoiceInputNativeControls = {
    isAvailable: true,
    supportsContinuous: true,
    permissionGranted: true,
    permissionCanAskAgain: true,
    permissionRestricted: false,
    ...overrides,
  };

  const permissionResponse = async (): Promise<VoiceInputNativePermission> => {
    const result = await Promise.resolve({
      granted: controls.permissionGranted,
      canAskAgain: controls.permissionCanAskAgain,
      restricted: controls.permissionRestricted,
    });
    return result;
  };

  const mocks: VoiceInputNativeMocks = {
    abort: vi.fn((): void => undefined),
    getPermissions: vi.fn(async () => {
      const result = await permissionResponse();
      return result;
    }),
    requestPermissions: vi.fn(async () => {
      const result = await permissionResponse();
      return result;
    }),
    start: vi.fn((_options: VoiceInputNativeStartOptions): void => undefined),
    stop: vi.fn((): void => undefined),
  };

  const listeners = new Map<keyof VoiceInputNativeEvent, Set<AnyListener>>();
  const native = buildNative(controls, mocks, listeners);

  const harness: VoiceInputNativeHarness = {
    controls,
    mocks,
    emit(event, payload): void {
      const set = listeners.get(event);
      if (!set) {
        return;
      }
      for (const listener of set) {
        listener(payload);
      }
    },
    emitResult(transcript, isFinal): void {
      harness.emit('result', { isFinal, results: [emptyResult(transcript)] });
    },
    listenerCount(event): number {
      return listeners.get(event)?.size ?? 0;
    },
    native,
  };
  return harness;
}

export function makeStartOptions(
  overrides: Partial<VoiceInputStartOptions> = {}
): VoiceInputStartOptions {
  return {
    baseDraft: '',
    languageTag: 'en-US',
    onDraftChange: (): void => undefined,
    onFeedback: (): void => undefined,
    owner: 'owner1',
    ...overrides,
  };
}

export function recordFeedback(): {
  feedback: {
    action: 'none' | 'open-settings';
    availability: 'available' | 'unavailable';
    message: string;
    retryable: boolean;
  }[];
  onFeedback: (fb: {
    action: 'none' | 'open-settings';
    availability: 'available' | 'unavailable';
    message: string;
    retryable: boolean;
  }) => void;
} {
  const feedback: {
    action: 'none' | 'open-settings';
    availability: 'available' | 'unavailable';
    message: string;
    retryable: boolean;
  }[] = [];
  return {
    feedback,
    onFeedback: (fb): void => {
      feedback.push(fb);
    },
  };
}

export function deferredPermission(): {
  promise: Promise<VoiceInputNativePermission>;
  resolve: (value: VoiceInputNativePermission) => void;
} {
  const { promise, resolve } = Promise.withResolvers<VoiceInputNativePermission>();
  return { promise, resolve };
}
