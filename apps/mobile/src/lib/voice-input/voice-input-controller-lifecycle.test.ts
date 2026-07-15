import { describe, expect, it } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  makeStartOptions,
  type VoiceInputNativeHarness,
} from './voice-input-controller-test-helpers';

async function isPending<T>(promise: Promise<T>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const result = await Promise.race([promise, Promise.resolve(sentinel)]);
  return result === sentinel;
}

describe('createVoiceInputController - lifecycle', () => {
  const build = (overrides: Partial<VoiceInputNativeHarness['controls']> = {}) => {
    const harness = createVoiceInputNativeHarness(overrides);
    const controller = createVoiceInputController(harness.native);
    return { harness, controller };
  };

  describe('subscribe', () => {
    it('notifies for starting, listening, stopping, and idle transitions', async () => {
      const { harness, controller } = build();
      const observed: string[] = [];
      controller.subscribe((snap): void => {
        observed.push(snap.status);
      });
      const started = await controller.start(makeStartOptions({ owner: 'A' }));
      expect(started).toBe(true);

      harness.emit('start', null);
      const stopped = controller.stop('A');
      harness.emit('end', null);
      const stopResult = await stopped;
      expect(stopResult).toBe(true);

      expect(observed).toEqual(
        expect.arrayContaining(['starting', 'listening', 'stopping', 'idle'])
      );
    });

    it('unsubscribe stops further notifications', async () => {
      const { harness, controller } = build();
      const observed: string[] = [];
      const unsubscribe = controller.subscribe((snap): void => {
        observed.push(snap.status);
      });
      unsubscribe();
      await controller.start(makeStartOptions());
      harness.emit('start', null);
      expect(observed).toEqual([]);
    });
  });

  describe('end and terminalization', () => {
    it('clears the owner, sets idle, and resolves the terminal promise with success', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions());
      harness.emit('start', null);
      const stopPromise = controller.stop('owner1');
      harness.emit('end', null);

      await expect(stopPromise).resolves.toBe(true);
      expect(controller.getSnapshot().owner).toBeNull();
      expect(controller.getSnapshot().status).toBe('idle');
    });

    it('resolves the terminal promise with false when a failure was reported before end', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions());
      harness.emit('start', null);
      const stopPromise = controller.stop('owner1');
      harness.emit('error', { error: 'no-speech', message: 'no speech' });
      harness.emit('end', null);

      await expect(stopPromise).resolves.toBe(false);
      expect(controller.getSnapshot().status).toBe('idle');
    });

    it('ignores duplicate or late events after terminalization', async () => {
      const { harness, controller } = build();
      const drafts: string[] = [];
      const feedback: {
        action: 'none' | 'open-settings';
        availability: 'available' | 'unavailable';
        message: string;
        retryable: boolean;
      }[] = [];
      await controller.start(
        makeStartOptions({
          owner: 'A',
          onDraftChange: (d): void => {
            drafts.push(d);
          },
          onFeedback: (f): void => {
            feedback.push(f);
          },
        })
      );
      harness.emit('start', null);
      harness.emitResult('hello', false);
      harness.emit('end', null);
      await controller.stop('A');

      drafts.length = 0;
      feedback.length = 0;

      harness.emitResult('late', false);
      harness.emit('error', { error: 'no-speech', message: 'late' });
      harness.emit('end', null);

      expect(drafts).toEqual([]);
      expect(feedback).toEqual([]);
      expect(controller.getSnapshot().status).toBe('idle');
    });
  });

  describe('stop', () => {
    it('returns true when there is no active session', async () => {
      const { harness, controller } = build();
      await expect(controller.stop('A')).resolves.toBe(true);
      expect(harness.mocks.stop).not.toHaveBeenCalled();
    });

    it('returns true for a non-owner call and leaves the active session alone', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);
      await expect(controller.stop('B')).resolves.toBe(true);
      expect(harness.mocks.stop).not.toHaveBeenCalled();
      expect(controller.getSnapshot().owner).toBe('A');
      expect(controller.getSnapshot().status).toBe('listening');
    });

    it('owner stop calls native.stop once, sets stopping, and resolves only after end', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);

      const stopPromise = controller.stop('A');
      expect(harness.mocks.stop).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().status).toBe('stopping');

      expect(await isPending(stopPromise)).toBe(true);

      harness.emit('end', null);
      await expect(stopPromise).resolves.toBe(true);
    });

    it('continues to process result events before end so the draft is updated', async () => {
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

      const stopPromise = controller.stop('owner1');
      harness.emitResult('final word', true);
      expect(drafts.at(-1)).toBe('final word');

      harness.emit('end', null);
      await expect(stopPromise).resolves.toBe(true);
    });

    it('reports client, terminalizes safely, and resolves false when native.stop throws', async () => {
      const { harness, controller } = build();
      harness.mocks.stop = ((): void => {
        throw new Error('boom');
      }) as typeof harness.mocks.stop;
      const feedback: {
        action: 'none' | 'open-settings';
        availability: 'available' | 'unavailable';
        message: string;
        retryable: boolean;
      }[] = [];
      await controller.start(
        makeStartOptions({
          onFeedback: (f): void => {
            feedback.push(f);
          },
        })
      );
      harness.emit('start', null);

      await expect(controller.stop('owner1')).resolves.toBe(false);

      expect(feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
      expect(controller.getSnapshot().owner).toBeNull();
      expect(controller.getSnapshot().status).toBe('idle');
    });
  });

  describe('abort', () => {
    it('returns true when there is no active session', async () => {
      const { harness, controller } = build();
      await expect(controller.abort()).resolves.toBe(true);
      expect(harness.mocks.abort).not.toHaveBeenCalled();
    });

    it('returns true for a specified non-owner call', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);
      await expect(controller.abort('B')).resolves.toBe(true);
      expect(harness.mocks.abort).not.toHaveBeenCalled();
      expect(controller.getSnapshot().owner).toBe('A');
    });

    it('active abort sets expectedAbort and stopping, calls native.abort once, and resolves after end', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);

      const abortPromise = controller.abort('A');
      expect(harness.mocks.abort).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().status).toBe('stopping');

      expect(await isPending(abortPromise)).toBe(true);

      harness.emit('error', { error: 'aborted', message: 'aborted' });
      harness.emit('end', null);
      await expect(abortPromise).resolves.toBe(true);
    });

    it('terminalizes safely and resolves false when native.abort throws', async () => {
      const { harness, controller } = build();
      harness.mocks.abort = ((): void => {
        throw new Error('boom');
      }) as typeof harness.mocks.abort;
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);

      await expect(controller.abort('A')).resolves.toBe(false);
      expect(controller.getSnapshot().owner).toBeNull();
      expect(controller.getSnapshot().status).toBe('idle');
    });
  });

  describe('dispose', () => {
    it('removes every permanent native listener and clears subscribers', () => {
      const { harness, controller } = build();
      controller.subscribe((): void => undefined);
      controller.dispose();

      expect(harness.listenerCount('start')).toBe(0);
      expect(harness.listenerCount('result')).toBe(0);
      expect(harness.listenerCount('nomatch')).toBe(0);
      expect(harness.listenerCount('error')).toBe(0);
      expect(harness.listenerCount('end')).toBe(0);
    });

    it('initiates an expected abort when active, terminalizes safely, and resolves', async () => {
      const { harness, controller } = build();
      const feedback: {
        action: 'none' | 'open-settings';
        availability: 'available' | 'unavailable';
        message: string;
        retryable: boolean;
      }[] = [];
      await controller.start(
        makeStartOptions({
          owner: 'A',
          onFeedback: (f): void => {
            feedback.push(f);
          },
        })
      );
      harness.emit('start', null);

      controller.dispose();

      expect(harness.mocks.abort).toHaveBeenCalledTimes(1);
      expect(feedback).toEqual([]);
      expect(controller.getSnapshot().owner).toBeNull();
      expect(controller.getSnapshot().status).toBe('idle');
    });

    it('resolves even when the native module never emits end after abort', async () => {
      const { harness, controller } = build();
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);
      controller.dispose();
      expect(controller.getSnapshot().status).toBe('idle');
    });
  });
});
