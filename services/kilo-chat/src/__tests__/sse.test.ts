import { describe, it, expect } from 'vitest';
import { formatSseEvent, SSE_PING } from '../lib/sse';

describe('formatSseEvent', () => {
  it('formats event with id', () => {
    const result = formatSseEvent('message.created', { foo: 'bar' }, '01ABC');
    expect(result).toBe('id: 01ABC\nevent: message.created\ndata: {"foo":"bar"}\n\n');
  });

  it('formats event without id', () => {
    const result = formatSseEvent('typing', { memberId: 'u1' });
    expect(result).toBe('event: typing\ndata: {"memberId":"u1"}\n\n');
  });
});

describe('SSE_PING', () => {
  it('is a comment line', () => {
    expect(SSE_PING).toBe(':ping\n\n');
  });
});
