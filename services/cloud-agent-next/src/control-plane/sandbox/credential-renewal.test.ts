import { describe, expect, it } from 'vitest';
import {
  credentialRenewalDueAt,
  nextCredentialRenewalAt,
  pruneCredentialRenewalRetries,
} from './credential-renewal.js';
import type { RouteRecord } from './routes.js';

const THRESHOLD = 60;
const NONE = new Map<string, number>();

function route(
  sessionId: string,
  expiresAt: number | null,
  state: RouteRecord['state'] = 'ready',
  scopeId = sessionId
): Pick<RouteRecord, 'sessionId' | 'state' | 'grant'> {
  const grant = expiresAt === null ? null : ({ expiresAt, scopeId } as RouteRecord['grant']);
  return { sessionId, state, grant };
}

describe('credentialRenewalDueAt', () => {
  it('is due when a ready grant enters the re-issue window', () => {
    expect(credentialRenewalDueAt(route('s', 1_000), THRESHOLD, NONE)).toBe(940);
  });

  it('ignores routes that are not ready or have no grant', () => {
    expect(credentialRenewalDueAt(route('s', 1_000, 'preparing'), THRESHOLD, NONE)).toBeNull();
    expect(credentialRenewalDueAt(route('s', null), THRESHOLD, NONE)).toBeNull();
  });

  it('waits for the retry time after a failed attempt', () => {
    expect(credentialRenewalDueAt(route('s', 1_000), THRESHOLD, new Map([['s', 970]]))).toBe(970);
  });

  it('never lets a retry delay the attempt past expiry', () => {
    expect(credentialRenewalDueAt(route('s', 1_000), THRESHOLD, new Map([['s', 1_200]]))).toBe(
      1_000
    );
  });

  it('shares one retry across the members of a scope', () => {
    const retries = new Map([['worktree_a', 970]]);
    expect(
      credentialRenewalDueAt(route('a', 1_000, 'ready', 'worktree_a'), THRESHOLD, retries)
    ).toBe(970);
    expect(
      credentialRenewalDueAt(route('b', 1_000, 'ready', 'worktree_a'), THRESHOLD, retries)
    ).toBe(970);
  });
});

describe('nextCredentialRenewalAt', () => {
  it('returns the earliest due time across ready routes', () => {
    const routes = [route('a', 2_000), route('b', 1_000), route('c', 500, 'failed')];
    expect(nextCredentialRenewalAt(routes, THRESHOLD, new Map([['b', 990]]))).toBe(990);
    expect(nextCredentialRenewalAt([], THRESHOLD, NONE)).toBeNull();
  });
});

describe('pruneCredentialRenewalRetries', () => {
  it('drops retries for scopes that have no ready route', () => {
    const retries = new Map([
      ['ready', 1],
      ['failed', 2],
      ['gone', 3],
      ['worktree_shared', 4],
    ]);
    pruneCredentialRenewalRetries(retries, [
      route('ready', 1_000),
      route('failed', 1_000, 'failed'),
      route('member', 1_000, 'ready', 'worktree_shared'),
    ]);
    expect([...retries.keys()]).toEqual(['ready', 'worktree_shared']);
  });
});
