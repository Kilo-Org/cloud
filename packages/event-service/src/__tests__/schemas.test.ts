import { describe, it, expect } from 'vitest';
import {
  eventMessageSchema,
  errorMessageSchema,
  ackMessageSchema,
  clientMessageSchema,
  serverMessageSchema,
} from '../schemas';

describe('eventMessageSchema', () => {
  it('accepts an event with a seq field', () => {
    const result = eventMessageSchema.safeParse({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: { taskId: '1' },
      seq: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(5);
    }
  });

  it('accepts an event without a seq field (backward compat)', () => {
    const result = eventMessageSchema.safeParse({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBeUndefined();
    }
  });

  it('rejects an event with a negative seq', () => {
    const result = eventMessageSchema.safeParse({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: {},
      seq: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event with a non-integer seq', () => {
    const result = eventMessageSchema.safeParse({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: {},
      seq: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event with a string seq', () => {
    const result = eventMessageSchema.safeParse({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: {},
      seq: '5',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an event with seq 0', () => {
    const result = eventMessageSchema.safeParse({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: {},
      seq: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(0);
    }
  });
});

describe('errorMessageSchema', () => {
  it('accepts an error with a seq field', () => {
    const result = errorMessageSchema.safeParse({
      type: 'error',
      code: 'too_many_contexts',
      max: 200,
      seq: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(10);
    }
  });

  it('accepts an error without a seq field (backward compat)', () => {
    const result = errorMessageSchema.safeParse({
      type: 'error',
      code: 'too_many_contexts',
      max: 200,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBeUndefined();
    }
  });
});

describe('ackMessageSchema', () => {
  it('accepts a valid ack message', () => {
    const result = ackMessageSchema.safeParse({ type: 'ack', seq: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(42);
    }
  });

  it('accepts an ack with seq 0', () => {
    const result = ackMessageSchema.safeParse({ type: 'ack', seq: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(0);
    }
  });

  it('rejects an ack with a negative seq', () => {
    const result = ackMessageSchema.safeParse({ type: 'ack', seq: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects an ack with a non-integer seq', () => {
    const result = ackMessageSchema.safeParse({ type: 'ack', seq: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects an ack with a missing seq', () => {
    const result = ackMessageSchema.safeParse({ type: 'ack' });
    expect(result.success).toBe(false);
  });
});

describe('clientMessageSchema (ack in discriminant union)', () => {
  it('parses an ack message as a client message', () => {
    const result = clientMessageSchema.safeParse({ type: 'ack', seq: 7 });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'ack') {
      expect(result.data.seq).toBe(7);
    }
  });

  it('still parses context.subscribe', () => {
    const result = clientMessageSchema.safeParse({
      type: 'context.subscribe',
      contexts: ['ctx:a'],
    });
    expect(result.success).toBe(true);
  });

  it('still parses context.unsubscribe', () => {
    const result = clientMessageSchema.safeParse({
      type: 'context.unsubscribe',
      contexts: ['ctx:a'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown message type', () => {
    const result = clientMessageSchema.safeParse({ type: 'unknown' });
    expect(result.success).toBe(false);
  });
});

describe('serverMessageSchema', () => {
  it('parses an event as a server message', () => {
    const result = serverMessageSchema.safeParse({
      type: 'event',
      context: 'project:a',
      event: 'x',
      payload: null,
      seq: 1,
    });
    expect(result.success).toBe(true);
  });

  it('parses an error as a server message', () => {
    const result = serverMessageSchema.safeParse({
      type: 'error',
      code: 'too_many_contexts',
      max: 200,
      seq: 1,
    });
    expect(result.success).toBe(true);
  });
});
