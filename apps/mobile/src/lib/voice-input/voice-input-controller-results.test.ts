import { describe, expect, it, vi } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  deferredPermission,
  makeStartOptions,
  recordFeedback,
  type VoiceInputNativeHarness,
} from './voice-input-controller-test-helpers';

describe('createVoiceInputController - events and serialization', () => {
  const build = (overrides: Partial<VoiceInputNativeHarness['controls']> = {}) => {
    const harness = createVoiceInputNativeHarness(overrides);
    const controller = createVoiceInputController(harness.native);
    return { harness, controller };
  };

  describe('lifecycle events', () => {
    it('moves to listening when the native start event fires for the current session', async () => {
      const { harness, controller } = build();
      const result = await controller.start(makeStartOptions());
      expect(result).toBe(true);
      harness.emit('start', null);
      expect(controller.getSnapshot().status).toBe('listening');
    });

    it('accumulates result transcripts and emits the appended base draft', async () => {
      const { harness, controller } = build();
      const drafts: string[] = [];
      const started = await controller.start(
        makeStartOptions({
          baseDraft: 'hi ',
          onDraftChange: (d): void => {
            drafts.push(d);
          },
        })
      );
      expect(started).toBe(true);
      harness.emit('start', null);

      harness.emitResult('hel', false);
      expect(drafts.at(-1)).toBe('hi hel');
      harness.emitResult('hello', true);
      expect(drafts.at(-1)).toBe('hi hello');
      harness.emitResult('there', false);
      expect(drafts.at(-1)).toBe('hi hello there');
    });

    it('ignores empty results and empty transcripts', async () => {
      const { harness, controller } = build();
      const drafts: string[] = [];
      await controller.start(
        makeStartOptions({
          onDraftChange: (d): void => {
            drafts.push(d);
          },
        })
      );
      harness.emit('start', null);

      harness.emit('result', { isFinal: false, results: [] });
      harness.emit('result', {
        isFinal: false,
        results: [{ transcript: '', confidence: 0, segments: [] }],
      });
      expect(drafts).toEqual([]);
    });

    it('reports the no-speech feedback on nomatch, and ignores subsequent nomatch events', async () => {
      const { harness, controller } = build();
      const fb = recordFeedback();
      await controller.start(makeStartOptions({ onFeedback: fb.onFeedback }));
      harness.emit('start', null);

      harness.emit('nomatch', null);
      harness.emit('nomatch', null);

      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'No speech detected. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
    });

    it('reports the mapped feedback on error, and reports only the first error', async () => {
      const { harness, controller } = build();
      const fb = recordFeedback();
      await controller.start(makeStartOptions({ onFeedback: fb.onFeedback }));
      harness.emit('start', null);

      harness.emit('error', { error: 'network', message: 'offline' });
      harness.emit('error', { error: 'busy', message: 'busy' });

      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input needs a connection right now. Try again.',
          retryable: true,
        },
      ]);
    });

    it('is silent on an expected abort error', async () => {
      const { harness, controller } = build();
      const fb = recordFeedback();
      await controller.start(makeStartOptions({ onFeedback: fb.onFeedback }));
      harness.emit('start', null);
      const abortPromise = controller.abort('owner1');
      harness.emit('error', { error: 'aborted', message: 'aborted' });
      harness.emit('end', null);
      await abortPromise;
      expect(fb.feedback).toEqual([]);
    });

    it('maps a non-expected aborted error through the classifier', async () => {
      const { harness, controller } = build();
      const fb = recordFeedback();
      await controller.start(makeStartOptions({ onFeedback: fb.onFeedback }));
      harness.emit('start', null);

      harness.emit('error', { error: 'aborted', message: 'aborted' });

      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
    });

    it('maps an unknown native error code to a generic retryable feedback without throwing', async () => {
      const { harness, controller } = build();
      const fb = recordFeedback();
      await controller.start(makeStartOptions({ onFeedback: fb.onFeedback }));
      harness.emit('start', null);

      harness.emit('error', {
        error: 'future-native-error',
        message: 'future',
      });

      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
    });

    it('permanently flips availability to unavailable when a service-not-allowed feedback is reported', async () => {
      const { harness, controller } = build();
      const fb = recordFeedback();
      await controller.start(makeStartOptions({ onFeedback: fb.onFeedback }));
      harness.emit('start', null);
      expect(controller.getSnapshot().availability).toBe('available');

      harness.emit('error', { error: 'service-not-allowed', message: 'no service' });
      expect(controller.getSnapshot().availability).toBe('unavailable');
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'unavailable',
          message: "Voice input isn't available on this device.",
          retryable: false,
        },
      ]);
    });
  });

  describe('start serialization', () => {
    it('waits for the previous session to end before checking permission for the new owner', async () => {
      const { harness, controller } = build();
      const started = await controller.start(makeStartOptions({ owner: 'A' }));
      expect(started).toBe(true);
      harness.emit('start', null);
      expect(harness.mocks.start).toHaveBeenCalledTimes(1);

      const bDeferred = deferredPermission();
      harness.mocks.getPermissions = vi.fn(async () => {
        const permission = await bDeferred.promise;
        return permission;
      });
      harness.mocks.requestPermissions = vi.fn(async () => {
        const permission = await bDeferred.promise;
        return permission;
      });

      const second = controller.start(makeStartOptions({ owner: 'B' }));
      // Let the first microtask flush: start should have entered and initiated abort on A.
      await Promise.resolve();
      expect(harness.mocks.abort).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().owner).toBe('A');
      expect(controller.getSnapshot().status).toBe('stopping');

      // B's permission must not be requested before A ends.
      expect(harness.mocks.getPermissions).not.toHaveBeenCalled();

      // A ends -> B can now request permission and complete startup.
      harness.emit('end', null);
      bDeferred.resolve({ granted: true, canAskAgain: true, restricted: false });
      await expect(second).resolves.toBe(true);
      expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
      expect(harness.mocks.start).toHaveBeenCalledTimes(2);
      expect(controller.getSnapshot().owner).toBe('B');
      expect(controller.getSnapshot().status).toBe('starting');
    });

    it('does not call native.start if dispose() races with a pending getPermissions', async () => {
      const { harness, controller } = build();
      const deferred = deferredPermission();
      harness.mocks.getPermissions = vi.fn(async () => {
        const permission = await deferred.promise;
        return permission;
      });
      harness.mocks.requestPermissions = vi.fn(async () => {
        const permission = await deferred.promise;
        return permission;
      });

      const started = controller.start(makeStartOptions({ owner: 'A' }));
      await Promise.resolve();
      // getPermissions is now in flight, waiting on the deferred.
      // The controller has no session yet; dispose should still resolve and the
      // pending permission should not trigger native.start.
      controller.dispose();
      deferred.resolve({ granted: true, canAskAgain: true, restricted: false });
      await expect(started).resolves.toBe(false);
      expect(harness.mocks.start).not.toHaveBeenCalled();
      expect(controller.getSnapshot().status).toBe('idle');
      expect(controller.getSnapshot().owner).toBeNull();
    });

    it('dispose resolves any active terminal promise and removes all listeners', async () => {
      const { harness, controller } = build();
      const started = await controller.start(makeStartOptions({ owner: 'A' }));
      expect(started).toBe(true);
      harness.emit('start', null);

      controller.dispose();
      expect(harness.listenerCount('start')).toBe(0);
      expect(harness.listenerCount('result')).toBe(0);
      expect(harness.listenerCount('nomatch')).toBe(0);
      expect(harness.listenerCount('error')).toBe(0);
      expect(harness.listenerCount('end')).toBe(0);
      expect(controller.getSnapshot().status).toBe('idle');
      expect(controller.getSnapshot().owner).toBeNull();
    });
  });
});
