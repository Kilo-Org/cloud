import { describe, it, expect } from 'vitest';
import { isDefiniteUnreachable } from '../services/bot-status-request';

describe('isDefiniteUnreachable', () => {
  it('classifies missing-routing errors as definitive', () => {
    expect(isDefiniteUnreachable(new Error('No routing target for sandbox-foo'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Instance for sandbox-foo has no sandboxId'))).toBe(
      true
    );
  });

  it('classifies upstream 4xx as definitive', () => {
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 401 Unauthorized'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 404 Not Found'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 410 Gone'))).toBe(true);
  });

  it('classifies upstream 5xx as transient', () => {
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 500 Internal'))).toBe(false);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 502 Bad Gateway'))).toBe(false);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 504 Gateway Timeout'))).toBe(
      false
    );
  });

  it('classifies network/abort errors as transient', () => {
    expect(isDefiniteUnreachable(new Error('fetch failed'))).toBe(false);
    expect(isDefiniteUnreachable(new Error('Aborted'))).toBe(false);
    expect(isDefiniteUnreachable(new TypeError('network error'))).toBe(false);
  });

  it('classifies unknown error shapes as transient', () => {
    expect(isDefiniteUnreachable('plain string')).toBe(false);
    expect(isDefiniteUnreachable(undefined)).toBe(false);
    expect(isDefiniteUnreachable(null)).toBe(false);
  });
});
