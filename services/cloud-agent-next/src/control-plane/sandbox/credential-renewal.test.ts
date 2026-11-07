import { describe, expect, it } from 'vitest';
import {
  credentialRenewalDueAt,
  nextCredentialRenewalAt,
  pruneCredentialRenewalRetries,
} from './credential-renewal.js';
import type { RouteRecord } from './routes.js';

const THRESHOLD = 60;

function route(
  sessionId: string,
  expiresAt: number | null,
  state: RouteRecord['state'] = 'ready'
): Pick<RouteRecord, 'sessionId' | 'state' | 'grant'> {
  const grant = expiresAt === null ? null : ({ expiresAt } as RouteRecord['grant']);
  return { sessionId, state, grant };
}

describe('credentialRenewalDueAt', () => {
  it('is due when a ready grant enters the re-issue window', () => {
    expect(credentialRenewalDueAt(route('s', 1_000), THRESHOLD, undefined)).toBe(940);
  });

  it('ignores routes that are not ready or have no grant', () => {
    expect(credentialRenewalDueAt(route('s', 1_000, 'preparing'), THRESHOLD, undefined)).toBeNull();
    expect(credentialRenewalDueAt(route('s', null), THRESHOLD, undefined)).toBeNull();
  });

  it('waits for the retry time after a failed attempt', () => {
    expect(credentialRenewalDueAt(route('s', 1_000), THRESHOLD, 970)).toBe(970);
  });

  it('never lets a retry delay the attempt past expiry', () => {
    expect(credentialRenewalDueAt(route('s', 1_000), THRESHOLD, 1_200)).toBe(1_000);
  });
});

describe('nextCredentialRenewalAt', () => {
  it('returns the earliest due time across ready routes', () => {
    const routes = [route('a', 2_000), route('b', 1_000), route('c', 500, 'failed')];
    expect(nextCredentialRenewalAt(routes, THRESHOLD, new Map([['b', 990]]))).toBe(990);
    expect(nextCredentialRenewalAt([], THRESHOLD, new Map())).toBeNull();
  });
});

describe('pruneCredentialRenewalRetries', () => {
  it('drops retries for routes that are gone or not ready', () => {
    const retries = new Map([
      ['ready', 1],
      ['failed', 2],
      ['gone', 3],
    ]);
    pruneCredentialRenewalRetries(retries, [
      route('ready', 1_000),
      route('failed', 1_000, 'failed'),
    ]);
    expect([...retries.keys()]).toEqual(['ready']);
  });
});
