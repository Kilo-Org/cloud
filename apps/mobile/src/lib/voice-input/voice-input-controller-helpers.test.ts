import { describe, expect, it } from 'vitest';

import { createVoiceInputStartQueue } from './voice-input-controller-helpers';

describe('createVoiceInputStartQueue', () => {
  it('runs without Promise.withResolvers support', async () => {
    const withResolvers = Promise.withResolvers.bind(Promise);
    Object.defineProperty(Promise, 'withResolvers', {
      configurable: true,
      value: undefined,
    });

    try {
      const queue = createVoiceInputStartQueue();
      await expect(
        queue.run({ cancelled: false, owner: 'A' }, async () => {
          await Promise.resolve();
          return true;
        })
      ).resolves.toBe(true);
    } finally {
      Object.defineProperty(Promise, 'withResolvers', {
        configurable: true,
        value: withResolvers,
      });
    }
  });
});
