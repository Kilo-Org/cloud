import { describe, it, expect } from 'vitest';
import {
  isTransientDurableObjectFailure,
  isDurableObjectRetryDeadline,
} from './durable-object-failure.js';

describe('isTransientDurableObjectFailure', () => {
  it('accepts the platform retryable flag when it survives the RPC boundary', () => {
    const error = Object.assign(new Error('anything'), { retryable: true });
    expect(isTransientDurableObjectFailure(error)).toBe(true);
  });

  it('accepts every observed overload family', () => {
    for (const message of [
      'Durable Object is overloaded. Too many requests queued.',
      'Durable Object is overloaded. Too much data queued.',
      'Durable Object is overloaded. Requests queued for too long.',
      'Durable Object is overloaded. Too many requests for the same object within a 10 second window.',
      'Your account is generating too much load on Durable Objects. Please back off and try again later.',
    ]) {
      expect(isTransientDurableObjectFailure(new Error(message))).toBe(true);
    }
  });

  it('accepts isolate resets and dropped connections', () => {
    for (const message of [
      "Durable Object's isolate exceeded its memory limit and was reset.",
      'Durable Object reset because its code was updated.',
      'Network connection lost.',
    ]) {
      expect(isTransientDurableObjectFailure(new Error(message))).toBe(true);
    }
  });

  it('rejects an operation that answered with its own error', () => {
    expect(isTransientDurableObjectFailure(new Error('Ticket already consumed'))).toBe(false);
    expect(isTransientDurableObjectFailure(new Error('Session not found'))).toBe(false);
    expect(
      isTransientDurableObjectFailure(Object.assign(new Error('x'), { retryable: false }))
    ).toBe(false);
  });

  it('rejects values that are not errors', () => {
    expect(isTransientDurableObjectFailure(null)).toBe(false);
    expect(isTransientDurableObjectFailure(undefined)).toBe(false);
    expect(
      isTransientDurableObjectFailure('Durable Object is overloaded. Too much data queued.')
    ).toBe(false);
  });
});

describe('isDurableObjectRetryDeadline', () => {
  it('recognizes the retry scope deadline', () => {
    expect(
      isDurableObjectRetryDeadline(
        new DOMException('Durable Object retry deadline exceeded', 'TimeoutError')
      )
    ).toBe(true);
  });

  it('does not treat an ordinary error as a deadline', () => {
    expect(isDurableObjectRetryDeadline(new Error('boom'))).toBe(false);
  });
});
