import { describe, expect, it, vi } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  makeStartOptions,
  recordFeedback,
} from './voice-input-controller-test-helpers';

/**
 * The controller bounds its own wait, so a bridge that stops answering still
 * releases the caller: the compose send lock awaits exactly this promise, and
 * the next start waits on the previous session settling.
 */
const BOUND_MS = 60_000;

function build() {
  const harness = createVoiceInputNativeHarness();
  const controller = createVoiceInputController(harness.native);
  return { harness, controller };
}

describe('createVoiceInputController - bounded terminal wait', () => {
  it('stop settles at the bound, reports the failure, and releases the session', async () => {
    vi.useFakeTimers();
    try {
      const { harness, controller } = build();
      const { feedback, onFeedback } = recordFeedback();
      await controller.start(makeStartOptions({ owner: 'A', onFeedback }));
      harness.emit('start', null);

      const stopped = controller.stop('A');
      expect(harness.mocks.stop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(BOUND_MS);
      await expect(stopped).resolves.toBe(false);

      expect(feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
      // The recognizer is released, so a stalled session cannot keep the
      // microphone or an in-flight upload alive.
      expect(harness.mocks.abort).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot()).toEqual({
        availability: 'available',
        owner: null,
        status: 'idle',
      });
      // A late end from the abandoned session changes nothing.
      harness.emit('end', null);
      expect(controller.getSnapshot().status).toBe('idle');
      expect(feedback).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort settles at the bound without feedback', async () => {
    vi.useFakeTimers();
    try {
      const { harness, controller } = build();
      const { feedback, onFeedback } = recordFeedback();
      await controller.start(makeStartOptions({ owner: 'A', onFeedback }));
      harness.emit('start', null);

      const aborted = controller.abort('A');
      await vi.advanceTimersByTimeAsync(BOUND_MS);
      await expect(aborted).resolves.toBe(false);

      expect(feedback).toEqual([]);
      expect(controller.getSnapshot().owner).toBeNull();
      expect(controller.getSnapshot().status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the next session when the previous one never reports end', async () => {
    vi.useFakeTimers();
    try {
      const { harness, controller } = build();
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);

      const next = controller.start(makeStartOptions({ owner: 'B' }));
      await vi.advanceTimersByTimeAsync(BOUND_MS);
      await expect(next).resolves.toBe(true);
      expect(harness.mocks.start).toHaveBeenCalledTimes(2);
      expect(controller.getSnapshot().owner).toBe('B');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a transcript that arrives before the new session reported its own start', async () => {
    vi.useFakeTimers();
    try {
      const { harness, controller } = build();
      const { feedback, onFeedback } = recordFeedback();
      const drafts: string[] = [];
      await controller.start(makeStartOptions({ owner: 'A' }));
      harness.emit('start', null);

      const next = controller.start(
        makeStartOptions({
          owner: 'B',
          onDraftChange: draft => {
            drafts.push(draft);
          },
          onFeedback,
        })
      );
      await vi.advanceTimersByTimeAsync(BOUND_MS);
      await expect(next).resolves.toBe(true);

      // A stalled recognizer can deliver the abandoned session's transcript
      // after the bound released it. It cannot belong to B, which has not
      // reported its own start yet, so it must not reach B's draft.
      harness.emitResult('stale words', true);
      expect(drafts).toEqual([]);
      expect(controller.getSnapshot().status).toBe('starting');
      expect(feedback).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
