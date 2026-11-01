import { describe, expect, it } from 'vitest';
import { toOwnerRepoAnswer } from './owner-repo-answer';
import type { ResolvedWasteland } from './resolve-wasteland';

function claimant(overrides: Partial<ResolvedWasteland> = {}): ResolvedWasteland {
  return {
    wastelandId: 'wl-a',
    ownerType: 'user',
    ownerUserId: 'user-1',
    organizationId: null,
    name: 'commons',
    dolthubUpstream: 'octo/commons',
    ...overrides,
  };
}

describe('toOwnerRepoAnswer', () => {
  it('answers null for an address with nothing to open', () => {
    expect(toOwnerRepoAnswer({ kind: 'none' })).toBeNull();
  });

  it('answers a single claimant as the flat identity an older bundle reads', () => {
    const answer = toOwnerRepoAnswer({ kind: 'resolved', wasteland: claimant() });

    // Exactly the fields the procedure answered with before one address
    // could carry several claimants: a bundle built then reads these and
    // nothing else, so they must stay flat and complete.
    expect(answer).toEqual({
      wastelandId: 'wl-a',
      ownerType: 'user',
      ownerUserId: 'user-1',
      organizationId: null,
      name: 'commons',
    });
    expect(Object.keys(answer ?? {}).sort()).toEqual([
      'name',
      'organizationId',
      'ownerType',
      'ownerUserId',
      'wastelandId',
    ]);
  });

  it('keeps the flat identity and adds every claimant when there are several', () => {
    const answer = toOwnerRepoAnswer({
      kind: 'ambiguous',
      candidates: [
        claimant(),
        claimant({ wastelandId: 'wl-b', name: 'second', ownerUserId: 'user-2' }),
      ],
    });

    expect(answer).toEqual({
      wastelandId: 'wl-a',
      ownerType: 'user',
      ownerUserId: 'user-1',
      organizationId: null,
      name: 'commons',
      candidates: [
        {
          wastelandId: 'wl-a',
          ownerType: 'user',
          ownerUserId: 'user-1',
          organizationId: null,
          name: 'commons',
        },
        {
          wastelandId: 'wl-b',
          ownerType: 'user',
          ownerUserId: 'user-2',
          organizationId: null,
          name: 'second',
        },
      ],
    });
  });

  it('takes the flat identity from the first claimant in the given order', () => {
    const answer = toOwnerRepoAnswer({
      kind: 'ambiguous',
      candidates: [
        claimant({ wastelandId: 'wl-0', name: 'first' }),
        claimant({ wastelandId: 'wl-9', name: 'last' }),
      ],
    });

    expect(answer?.wastelandId).toBe('wl-0');
    expect(answer?.name).toBe('first');
  });

  it('answers only the identity fields the address needs', () => {
    const single = toOwnerRepoAnswer({ kind: 'resolved', wasteland: claimant() });
    const several = toOwnerRepoAnswer({ kind: 'ambiguous', candidates: [claimant(), claimant()] });

    expect(single).not.toHaveProperty('dolthubUpstream');
    expect(several?.candidates?.[0]).not.toHaveProperty('dolthubUpstream');
  });
});
