import { describe, expect, it } from 'vitest';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import { createCredentialPolicyOwner, type PolicyWriteResolution } from './credential-policy.js';

function grant(scopeId: string): SessionCredentialGrant {
  return {
    scopeId,
    expiresAt: 100,
    members: [{ sessionId: `session_${scopeId}`, kiloSessionId: `kilo_${scopeId}` }],
    kilo: { runtimeProxy: { members: [] } },
  } as unknown as SessionCredentialGrant;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function setup(input: {
  deadlineMs?: number;
  apply?: (grants: readonly SessionCredentialGrant[]) => Promise<void>;
  live?: SessionCredentialGrant[];
  allocationId?: string;
}) {
  let resolution: PolicyWriteResolution = {
    kind: 'write',
    allocationId: input.allocationId ?? 'alloc_a',
    apply: input.apply ?? (async () => undefined),
  };
  const owner = createCredentialPolicyOwner({
    deadlineMs: () => input.deadlineMs ?? 1_000,
    resolveWrite: () => resolution,
    liveGrants: () => input.live ?? [grant('scope_a')],
  });
  return {
    owner,
    setResolution(next: PolicyWriteResolution) {
      resolution = next;
    },
  };
}

describe('credential policy owner', () => {
  it('does not run a renewal guard until the prior raw writer has settled', async () => {
    const first = deferred();
    let started = false;
    const harness = setup({
      apply: () => {
        started = true;
        return first.promise;
      },
    });
    const live = harness.owner.applyLive();
    await tick();
    expect(started).toBe(true);

    let guardCalled = false;
    const renewal = harness.owner.applyRenewalCandidate(grant('scope_a'), () => {
      guardCalled = true;
      return 'current';
    });
    await tick();
    expect(guardCalled).toBe(false);

    first.resolve();
    expect(await live).toEqual({ result: 'applied', wrote: true, allocationId: 'alloc_a' });
    expect(await renewal).toEqual({
      result: 'applied',
      wrote: true,
      allocationId: 'alloc_a',
      verdict: 'current',
    });
    expect(guardCalled).toBe(true);
  });

  it('skips the provider call and preserves a noncurrent verdict', async () => {
    const calls: SessionCredentialGrant[][] = [];
    const harness = setup({
      apply: async grants => {
        calls.push([...grants]);
      },
    });
    const result = await harness.owner.applyRenewalCandidate(grant('scope_a'), () => 'released');
    expect(result).toEqual({
      result: 'applied',
      wrote: false,
      allocationId: 'alloc_a',
      verdict: 'released',
    });
    expect(calls).toEqual([]);
  });

  it('leaves the verdict null when the guard never runs', async () => {
    let guardCalled = false;
    const harness = setup({});
    harness.setResolution({ kind: 'skip', allocationId: 'alloc_a' });
    const result = await harness.owner.applyRenewalCandidate(grant('scope_a'), () => {
      guardCalled = true;
      return 'current';
    });
    expect(guardCalled).toBe(false);
    expect(result).toEqual({
      result: 'applied',
      wrote: false,
      allocationId: 'alloc_a',
      verdict: null,
    });
  });

  it('fails closed for a timed-out lane and never orders a later write behind it', async () => {
    const pending = deferred();
    let firstCalls = 0;
    const harness = setup({
      deadlineMs: 5,
      apply: () => {
        firstCalls += 1;
        return pending.promise;
      },
    });
    expect(await harness.owner.applyLive()).toEqual({
      result: 'uncertain',
      wrote: true,
      allocationId: 'alloc_a',
    });
    expect(firstCalls).toBe(1);

    let laterCalls = 0;
    harness.setResolution({
      kind: 'write',
      allocationId: 'alloc_a',
      apply: async () => {
        laterCalls += 1;
      },
    });
    expect(await harness.owner.applyLive()).toEqual({
      result: 'failed',
      wrote: false,
      allocationId: 'alloc_a',
    });
    expect(laterCalls).toBe(0);

    harness.setResolution({
      kind: 'write',
      allocationId: 'alloc_b',
      apply: async () => {
        laterCalls += 1;
      },
    });
    expect(await harness.owner.applyLive()).toEqual({
      result: 'applied',
      wrote: true,
      allocationId: 'alloc_b',
    });
    expect(laterCalls).toBe(1);

    pending.resolve();
  });

  it('never moves a pending operation onto a replacement allocation', async () => {
    const blocker = deferred();
    let oldCalls = 0;
    const harness = setup({
      apply: () => {
        oldCalls += 1;
        return blocker.promise;
      },
    });
    const first = harness.owner.applyLive();
    await tick();
    expect(oldCalls).toBe(1);

    const queued = harness.owner.applyLive();
    await tick();
    let replacementCalls = 0;
    harness.setResolution({
      kind: 'write',
      allocationId: 'alloc_b',
      apply: async () => {
        replacementCalls += 1;
      },
    });
    blocker.resolve();

    expect(await first).toEqual({
      result: 'applied',
      wrote: true,
      allocationId: 'alloc_a',
    });
    expect(await queued).toEqual({
      result: 'obsolete',
      wrote: false,
      allocationId: 'alloc_a',
    });
    expect(replacementCalls).toBe(0);
  });

  it.each(['write', 'unavailable', 'skip'] as const)(
    'does not reconcile an old allocation against a replacement that is %s',
    async kind => {
      let calls = 0;
      const harness = setup({});
      harness.setResolution({
        kind,
        allocationId: 'alloc_b',
        apply: async () => {
          calls += 1;
        },
      });
      expect(await harness.owner.applyLive('alloc_a')).toEqual({
        result: 'obsolete',
        wrote: false,
        allocationId: 'alloc_a',
      });
      expect(calls).toBe(0);
    }
  );

  it('lets a confirmed failed write be repaired on the same lane', async () => {
    const harness = setup({
      apply: () => Promise.reject(new Error('provider rejected the candidate')),
    });
    expect(await harness.owner.applyCandidate(grant('scope_a'))).toEqual({
      result: 'failed',
      wrote: true,
      allocationId: 'alloc_a',
    });

    harness.setResolution({
      kind: 'write',
      allocationId: 'alloc_a',
      apply: async () => undefined,
    });
    expect(await harness.owner.applyLive()).toEqual({
      result: 'applied',
      wrote: true,
      allocationId: 'alloc_a',
    });
  });

  it('projects the live grants and the candidate together at write time', async () => {
    let seen: readonly SessionCredentialGrant[] = [];
    const live = [grant('scope_a'), grant('healthy')];
    const harness = setup({
      live,
      apply: async grants => {
        seen = grants;
      },
    });
    const candidate = grant('scope_a');
    await harness.owner.applyCandidate(candidate);
    expect(seen).toEqual([grant('healthy'), candidate]);
  });
});
