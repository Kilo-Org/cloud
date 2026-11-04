import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionNativeEventMap,
  type ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOsVoiceInputNative } from './os-voice-input-native';
import { createVoiceInputController } from './voice-input-controller';
import { makeStartOptions, recordFeedback } from './voice-input-controller-test-helpers';
import { createSelectingVoiceInputNative } from './voice-input-engine-select';

type KiloEvent = ExpoSpeechRecognitionNativeEventMap['kiloEvent'];
const bridge = vi.hoisted(() => {
  const listeners = new Set<(event: KiloEvent) => void>();
  return {
    listeners,
    addListener: vi.fn((name: string, listener: (event: KiloEvent) => void) => {
      if (name !== 'kiloEvent') {
        throw new Error('The app must not subscribe to uncorrelated native events.');
      }
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    start: vi.fn<(options: ExpoSpeechRecognitionOptions) => void>(),
    stop: vi.fn<() => void>(),
    abort: vi.fn<() => void>(),
    getPermissionsAsync: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    requestPermissionsAsync: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    isRecognitionAvailable: vi.fn().mockReturnValue(true),
    supportsOnDeviceRecognition: vi.fn().mockReturnValue(true),
  };
});
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: bridge }));

function emit(event: KiloEvent) {
  for (const listener of bridge.listeners) {
    listener(event);
  }
}

function build(os: 'ios' | 'android' = 'ios') {
  const native = createOsVoiceInputNative(ExpoSpeechRecognitionModule, { OS: os, Version: 36 });
  const selecting = createSelectingVoiceInputNative({ os: native, gateway: native }, () => 'os');
  return createVoiceInputController(selecting);
}

function result(sessionId: number, transcript: string): KiloEvent {
  return {
    sessionId,
    event: 'result',
    payload: { isFinal: true, results: [{ transcript, confidence: 1, segments: [] }] },
  };
}

beforeEach(() => {
  bridge.listeners.clear();
  bridge.addListener.mockClear();
  bridge.start.mockReset();
  bridge.stop.mockReset();
  bridge.abort.mockReset();
});

describe('OS voice input native run identity', () => {
  it.each(['ios', 'android'] as const)(
    '%s keeps the automatically queued next session alive when the abandoned run posts terminal events',
    async os => {
      vi.useFakeTimers();
      const controller = build(os);
      try {
        await controller.start(makeStartOptions({ owner: 'A' }));
        emit({ sessionId: 1, event: 'start', payload: null });
        const next = controller.start(makeStartOptions({ owner: 'B' }));
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(next).resolves.toBe(true);
        expect(bridge.start.mock.calls.map(([options]) => options.kiloSessionId)).toEqual([1, 2]);
        emit({ sessionId: 2, event: 'start', payload: null });
        expect(controller.getSnapshot().status).toBe('listening');

        emit({
          sessionId: 1,
          event: 'error',
          payload: { error: 'aborted', message: 'Speech recognition aborted.' },
        });
        emit({ sessionId: 1, event: 'end', payload: null });
        expect(controller.getSnapshot()).toMatchObject({ owner: 'B', status: 'listening' });
        emit({ sessionId: 2, event: 'end', payload: null });
        expect(controller.getSnapshot().status).toBe('idle');
        expect(bridge.addListener.mock.calls.every(([name]) => name === 'kiloEvent')).toBe(true);
      } finally {
        controller.dispose();
        vi.useRealTimers();
      }
    }
  );

  it('drops stale results and no-match after the next start before touching iOS deduplication', async () => {
    vi.useFakeTimers();
    const controller = build();
    const drafts: string[] = [];
    const { feedback, onFeedback } = recordFeedback();
    try {
      await controller.start(makeStartOptions({ owner: 'A' }));
      emit({ sessionId: 1, event: 'start', payload: null });
      const next = controller.start(
        makeStartOptions({
          owner: 'B',
          onDraftChange: text => {
            drafts.push(text);
          },
          onFeedback,
        })
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await next;
      emit({ sessionId: 2, event: 'start', payload: null });
      emit(result(1, 'same words'));
      emit({ sessionId: 1, event: 'nomatch', payload: null });
      expect(drafts).toEqual([]);
      expect(feedback).toEqual([]);
      emit(result(2, 'same words'));
      expect(drafts).toEqual(['same words']);
      expect(controller.getSnapshot()).toMatchObject({ owner: 'B', status: 'listening' });
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('accepts a genuine failed-start error and end without requiring a start event', async () => {
    const controller = build();
    const { feedback, onFeedback } = recordFeedback();
    bridge.start.mockImplementation(options => {
      const sessionId = options.kiloSessionId;
      if (sessionId === undefined) {
        throw new Error('A native recognition run needs its identity before start.');
      }
      emit({
        sessionId,
        event: 'error',
        payload: { error: 'not-allowed', message: 'Missing RECORD_AUDIO permissions.' },
      });
      emit({ sessionId, event: 'end', payload: null });
    });
    try {
      await controller.start(makeStartOptions({ owner: 'A', onFeedback }));
      expect(controller.getSnapshot()).toMatchObject({ owner: null, status: 'idle' });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.action).toBe('open-settings');
    } finally {
      controller.dispose();
    }
  });
});
