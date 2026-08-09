import { describe, expect, it } from 'vitest';
import { ExportQueueMessageSchema } from './contracts';

describe('ExportQueueMessageSchema', () => {
  it('accepts only a versioned durable generation reference', () => {
    expect(
      ExportQueueMessageSchema.safeParse({
        version: 1,
        operation: 'generate',
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: 0,
      }).success
    ).toBe(true);
    expect(
      ExportQueueMessageSchema.safeParse({
        version: 1,
        operation: 'generate',
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: -1,
        prompt: 'must not be present',
      }).success
    ).toBe(false);
  });
});
