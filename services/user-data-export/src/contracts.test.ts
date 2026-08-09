import { describe, expect, it } from 'vitest';
import { ExportQueueMessageSchema, parseCursor } from './contracts';

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

describe('parseCursor', () => {
  it('accepts strict ISO cursors and rejects malformed persisted values', () => {
    expect(parseCursor({ createdAt: '2026-08-03T00:00:00.123456Z', id: 'row-id' })).toEqual({
      createdAt: '2026-08-03T00:00:00.123456Z',
      id: 'row-id',
    });
    expect(parseCursor({ createdAt: 'not-a-date', id: 'row-id' })).toBeNull();
    expect(parseCursor({ createdAt: '2026-08-03T00:00:00.123456Z', id: '' })).toBeNull();
  });
});
