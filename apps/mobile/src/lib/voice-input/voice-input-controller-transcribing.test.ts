import { describe, expect, it, vi } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  makeStartOptions,
  recordFeedback,
} from './voice-input-controller-test-helpers';

describe('voice-input controller - transcribing status', () => {
  it('sets status to transcribing on the event and terminalizes on end', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const statuses: string[] = [];
    const unsubscribe = controller.subscribe(snapshot => {
      statuses.push(snapshot.status);
    });

    await controller.start(makeStartOptions());
    harness.emit('start', null);
    expect(controller.getSnapshot().status).toBe('listening');

    const settled = controller.stop('owner1');
    // `stop()` sets 'stopping'; the engine's synchronous `transcribing`
    // emission must take over so the row shows the upload phase.
    harness.emit('transcribing', null);
    expect(controller.getSnapshot().status).toBe('transcribing');

    harness.emit('result', {
      isFinal: true,
      results: [{ transcript: 'hi', confidence: 1, segments: [] }],
    });
    harness.emit('end', null);
    await expect(settled).resolves.toBe(true);

    expect(controller.getSnapshot().status).toBe('idle');
    expect(statuses).toContain('transcribing');
    unsubscribe();
  });

  it('terminalizes as a failure when the engine errors after transcribing', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const { feedback, onFeedback } = recordFeedback();

    await controller.start(makeStartOptions({ onFeedback }));
    harness.emit('start', null);
    const settled = controller.stop('owner1');
    harness.emit('transcribing', null);
    harness.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    harness.emit('end', null);

    await expect(settled).resolves.toBe(false);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('ignores a transcribing event once the session is terminalized', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);

    await controller.start(makeStartOptions());
    harness.emit('start', null);
    const settled = controller.stop('owner1');
    harness.emit('transcribing', null);
    harness.emit('end', null);
    await settled;
    const notify = vi.fn((): void => undefined);
    controller.subscribe(notify);

    // A late engine emission must not resurrect a status.
    harness.emit('transcribing', null);
    expect(controller.getSnapshot().status).toBe('idle');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('voice-input controller - refreshAvailability', () => {
  it('flips availability when the native answer changes and notifies subscribers', () => {
    const harness = createVoiceInputNativeHarness({ isAvailable: false });
    const controller = createVoiceInputController(harness.native);
    expect(controller.getSnapshot().availability).toBe('unavailable');

    const seen: string[] = [];
    const unsubscribe = controller.subscribe(snapshot => {
      seen.push(snapshot.availability);
    });

    // Gateway transcription enabled on an OS-unavailable device: the mic
    // button must appear without an app restart.
    harness.controls.isAvailable = true;
    controller.refreshAvailability();
    expect(controller.getSnapshot().availability).toBe('available');
    expect(seen).toEqual(['available']);

    // Unchanged value notifies nobody.
    controller.refreshAvailability();
    expect(seen).toEqual(['available']);
    unsubscribe();
  });

  it('is exposed on the returned controller object', () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    expect(typeof controller.refreshAvailability).toBe('function');
  });
});
