import { describe, it, expect } from 'vitest';
import { isDefiniteUnreachable } from '../services/bot-status-request';

describe('isDefiniteUnreachable', () => {
  it('classifies missing-routing errors as definitive', () => {
    expect(isDefiniteUnreachable(new Error('No routing target for sandbox-foo'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Instance for sandbox-foo has no sandboxId'))).toBe(
      true
    );
  });

  // Regression: deliverChatWebhook refuses to fetch() against a non-running
  // instance to prevent Fly Proxy autostart on suspended/stopped machines.
  // The classifier must treat that throw as definitive so chat dispatchers
  // immediately publish online: false instead of retrying forever and
  // showing a stale "online" indicator.
  it('classifies non-running instance errors as definitive', () => {
    expect(
      isDefiniteUnreachable(new Error('Instance for sandbox-foo is not running (status=stopped)'))
    ).toBe(true);
    expect(
      isDefiniteUnreachable(
        new Error('Instance for instance abc-123 is not running (status=provisioned)')
      )
    ).toBe(true);
    // The match is on the prefix "is not running" so additional status
    // values introduced later in the worker still classify correctly
    // without requiring a lock-step update here.
    expect(
      isDefiniteUnreachable(
        new Error('Instance for sandbox-foo is not running (status=some_future_state)')
      )
    ).toBe(true);
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
