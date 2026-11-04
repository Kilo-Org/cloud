import { describe, expect, it, vi } from 'vitest';
import type { GastownAccessVerdict } from '../../util/gastown-access-flag.util';
import {
  OWNER_ACCESS_CHECK_INTERVAL_MS,
  OWNER_ACCESS_FLAG_CACHE_TTL_MS,
  refreshOwnerAccess,
  type OwnerAccessDeps,
  type OwnerAccessState,
} from './owner-access';

const NOW = 1_000_000_000;

function makeDeps(options: {
  state?: OwnerAccessState;
  ownerUserId?: string;
  verdict?: GastownAccessVerdict;
  applyToContainer?: OwnerAccessDeps['applyToContainer'];
}) {
  let state = options.state;
  const evaluateAccess = vi.fn().mockResolvedValue(options.verdict ?? 'allowed');
  const applyToContainer = vi.fn(options.applyToContainer ?? (() => Promise.resolve()));
  const deps: OwnerAccessDeps = {
    getOwnerUserId: () => Promise.resolve(options.ownerUserId),
    evaluateAccess,
    getState: () => Promise.resolve(state),
    setState: next => {
      state = next;
      return Promise.resolve();
    },
    applyToContainer,
    now: () => NOW,
  };
  return { deps, evaluateAccess, applyToContainer, getState: () => state };
}

describe('refreshOwnerAccess', () => {
  it('revokes container starts when the owner flag is off', async () => {
    const t = makeDeps({ ownerUserId: 'user-1', verdict: 'denied' });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.evaluateAccess).toHaveBeenCalledWith('user-1');
    expect(t.applyToContainer).toHaveBeenCalledWith(true);
    expect(t.getState()).toEqual({ revoked: true, checkedAt: NOW, evaluatedAt: NOW });
  });

  it('restores container starts when the owner flag turns on', async () => {
    const t = makeDeps({
      state: { revoked: true, checkedAt: NOW - OWNER_ACCESS_CHECK_INTERVAL_MS },
      ownerUserId: 'user-1',
      verdict: 'allowed',
    });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(false);
    expect(t.applyToContainer).toHaveBeenCalledWith(false);
    expect(t.getState()).toEqual({ revoked: false, checkedAt: NOW, evaluatedAt: NOW });
  });

  it('reuses a recent verdict without calling PostHog', async () => {
    const state = { revoked: true, checkedAt: NOW - OWNER_ACCESS_CHECK_INTERVAL_MS + 1 };
    const t = makeDeps({ state, ownerUserId: 'user-1', verdict: 'allowed' });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.evaluateAccess).not.toHaveBeenCalled();
    expect(t.applyToContainer).not.toHaveBeenCalled();
    expect(t.getState()).toBe(state);
  });

  it('keeps the previous verdict when PostHog gives no answer', async () => {
    const t = makeDeps({
      state: { revoked: true, checkedAt: NOW - OWNER_ACCESS_CHECK_INTERVAL_MS },
      ownerUserId: 'user-1',
      verdict: 'unknown',
    });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.applyToContainer).not.toHaveBeenCalled();
    expect(t.getState()).toEqual({ revoked: true, checkedAt: NOW });
  });

  it.each([false, true])(
    'caches revoked=%s for one week without extending expiry',
    async revoked => {
      expect(OWNER_ACCESS_FLAG_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60_000);
      const evaluatedAt = NOW - OWNER_ACCESS_FLAG_CACHE_TTL_MS + 1;
      const t = makeDeps({
        state: { revoked, checkedAt: NOW - OWNER_ACCESS_CHECK_INTERVAL_MS, evaluatedAt },
        ownerUserId: 'user-1',
        verdict: revoked ? 'allowed' : 'denied',
      });

      await expect(refreshOwnerAccess(t.deps)).resolves.toBe(revoked);
      expect(t.evaluateAccess).not.toHaveBeenCalled();
      expect(t.applyToContainer).toHaveBeenCalledWith(revoked);
      expect(t.getState()).toEqual({ revoked, checkedAt: NOW, evaluatedAt });
    }
  );

  it.each([false, true])('refreshes revoked=%s when the one-week cache expires', async revoked => {
    const t = makeDeps({
      state: {
        revoked,
        checkedAt: NOW - OWNER_ACCESS_CHECK_INTERVAL_MS,
        evaluatedAt: NOW - OWNER_ACCESS_FLAG_CACHE_TTL_MS,
      },
      ownerUserId: 'user-1',
      verdict: revoked ? 'allowed' : 'denied',
    });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(!revoked);
    expect(t.evaluateAccess).toHaveBeenCalledExactlyOnceWith('user-1');
    expect(t.applyToContainer).toHaveBeenCalledWith(!revoked);
    expect(t.getState()).toEqual({ revoked: !revoked, checkedAt: NOW, evaluatedAt: NOW });
  });

  it('retries an unknown verdict after ten minutes instead of caching it for a week', async () => {
    const evaluatedAt = NOW - OWNER_ACCESS_FLAG_CACHE_TTL_MS;
    const t = makeDeps({
      state: { revoked: true, checkedAt: NOW - OWNER_ACCESS_CHECK_INTERVAL_MS, evaluatedAt },
      ownerUserId: 'user-1',
      verdict: 'unknown',
    });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.getState()).toEqual({ revoked: true, checkedAt: NOW, evaluatedAt });

    t.deps.now = () => NOW + OWNER_ACCESS_CHECK_INTERVAL_MS - 1;
    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.evaluateAccess).toHaveBeenCalledTimes(1);

    t.deps.now = () => NOW + OWNER_ACCESS_CHECK_INTERVAL_MS;
    t.evaluateAccess.mockResolvedValue('allowed');
    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(false);
    expect(t.evaluateAccess).toHaveBeenCalledTimes(2);
    expect(t.getState()).toEqual({
      revoked: false,
      checkedAt: NOW + OWNER_ACCESS_CHECK_INTERVAL_MS,
      evaluatedAt: NOW + OWNER_ACCESS_CHECK_INTERVAL_MS,
    });
  });

  it('does not revoke a town without an owner user', async () => {
    const t = makeDeps({ ownerUserId: undefined });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(false);
    expect(t.evaluateAccess).not.toHaveBeenCalled();
    expect(t.applyToContainer).not.toHaveBeenCalled();
  });

  it('keeps the verdict when the container update fails', async () => {
    const t = makeDeps({
      ownerUserId: 'user-1',
      verdict: 'denied',
      applyToContainer: () => Promise.reject(new Error('container unavailable')),
    });

    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.getState()).toEqual({ revoked: true, checkedAt: NOW, evaluatedAt: NOW });

    t.deps.now = () => NOW + OWNER_ACCESS_CHECK_INTERVAL_MS;
    await expect(refreshOwnerAccess(t.deps)).resolves.toBe(true);
    expect(t.evaluateAccess).toHaveBeenCalledTimes(1);
    expect(t.applyToContainer).toHaveBeenCalledTimes(2);
  });
});
