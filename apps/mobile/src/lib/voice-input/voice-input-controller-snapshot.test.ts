import { describe, expect, it } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  makeStartOptions,
  type VoiceInputNativeHarness,
} from './voice-input-controller-test-helpers';

describe('createVoiceInputController - snapshot identity', () => {
  const build = (overrides: Partial<VoiceInputNativeHarness['controls']> = {}) => {
    const harness = createVoiceInputNativeHarness(overrides);
    const controller = createVoiceInputController(harness.native);
    return { harness, controller };
  };

  it('returns the same snapshot object from consecutive getSnapshot() calls without a state transition', () => {
    const { controller } = build();

    const first = controller.getSnapshot();
    const second = controller.getSnapshot();

    expect(second).toBe(first);
  });

  it('changes snapshot identity after a state transition and keeps it stable until the next transition', async () => {
    const { harness, controller } = build();

    const idleSnapshot = controller.getSnapshot();
    expect(idleSnapshot.status).toBe('idle');

    const started = await controller.start(makeStartOptions({ owner: 'A' }));
    expect(started).toBe(true);

    const startingSnapshot = controller.getSnapshot();
    expect(startingSnapshot).not.toBe(idleSnapshot);
    expect(startingSnapshot.status).toBe('starting');
    expect(startingSnapshot.owner).toBe('A');

    // Same object after the transition until the next one.
    expect(controller.getSnapshot()).toBe(startingSnapshot);

    harness.emit('start', null);

    const listeningSnapshot = controller.getSnapshot();
    expect(listeningSnapshot).not.toBe(startingSnapshot);
    expect(listeningSnapshot.status).toBe('listening');

    expect(controller.getSnapshot()).toBe(listeningSnapshot);
  });
});
