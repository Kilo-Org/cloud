import { describe, expect, it, vi } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  makeStartOptions,
  recordFeedback,
} from './voice-input-controller-test-helpers';

describe('voice-input controller - engine fell back feedback', () => {
  it('surfaces one retryable toast through the session feedback path on a mid-session hand-off', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const { feedback, onFeedback } = recordFeedback();

    await controller.start(makeStartOptions({ onFeedback }));
    harness.emit('start', null);
    // The gateway upload failed and the dispatcher handed the live session
    // to the device recogniser.
    harness.emit('engine-fell-back', { from: 'gateway', to: 'os' });

    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.action).toBe('none');
    expect(feedback[0]?.availability).toBe('available');
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toContain("device's recogniser");

    // The session itself is still healthy: the fallback finishes it.
    harness.emit('end', null);
  });

  it('announces the gateway taking over when the device recogniser failed', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const { feedback, onFeedback } = recordFeedback();

    await controller.start(makeStartOptions({ onFeedback }));
    harness.emit('start', null);
    harness.emit('engine-fell-back', { from: 'os', to: 'gateway' });

    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.message).toContain('Kilo gateway');
    expect(feedback[0]?.message).toContain('say it again');
  });

  it('stays silent once the session has already failed', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const { feedback, onFeedback } = recordFeedback();

    await controller.start(makeStartOptions({ onFeedback }));
    harness.emit('start', null);
    harness.emit('error', { error: 'network', message: 'offline' });
    harness.emit('engine-fell-back', { from: 'gateway', to: 'os' });

    // The failed session already has its error message; the hand-off toast
    // must never stack a second one on top.
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.message).toContain('connection');
  });

  it('stays silent once the session is terminalized', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const { feedback, onFeedback } = recordFeedback();
    const notify = vi.fn((): void => undefined);

    await controller.start(makeStartOptions({ onFeedback }));
    harness.emit('start', null);
    const settled = controller.stop('owner1');
    harness.emit('transcribing', null);
    harness.emit('end', null);
    await settled;
    controller.subscribe(notify);

    // A late hand-off event must not resurrect a message or a status.
    harness.emit('engine-fell-back', { from: 'gateway', to: 'os' });
    expect(feedback).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('stays silent on an expected abort', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const { feedback, onFeedback } = recordFeedback();

    await controller.start(makeStartOptions({ onFeedback }));
    harness.emit('start', null);
    const settled = controller.abort('owner1');
    harness.emit('engine-fell-back', { from: 'gateway', to: 'os' });

    expect(feedback).toEqual([]);
    harness.emit('end', null);
    await settled;
  });
});
