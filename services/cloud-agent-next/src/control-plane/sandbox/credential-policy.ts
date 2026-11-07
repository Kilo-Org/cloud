import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import type { RenewalVerdict } from './credential-renewal.js';
import { scopeGrantId } from './scope-grants.js';

/**
 * Serializes Vercel credential-policy writes per physical allocation. The
 * caller supplies synchronous projections because the guard, live grants and
 * write target must be read in the same turn as the raw write. This module never
 * enters the Sandbox DO's operation queue.
 */
export type CredentialPolicyResult = 'applied' | 'failed' | 'uncertain' | 'obsolete';

export type CredentialPolicyOutcome = {
  result: CredentialPolicyResult;
  /** True when a provider call was started (its remote effect may be unknown). */
  wrote: boolean;
  /** The allocation the operation was bound to; null when no allocation existed. */
  allocationId: string | null;
};

export type RenewalPolicyOutcome = CredentialPolicyOutcome & {
  /** Null when the guard did not run because there was no provider write. */
  verdict: RenewalVerdict | null;
};

export type PolicyWrite = {
  allocationId: string;
  apply(grants: readonly SessionCredentialGrant[]): Promise<void>;
};

export type PolicyWriteResolution =
  | { kind: 'skip'; allocationId: string | null }
  | { kind: 'unavailable'; allocationId: string | null }
  | ({ kind: 'write' } & PolicyWrite);

export type CredentialPolicyOwnerOptions = {
  /** Bounds the caller, not the raw write. */
  deadlineMs(): number;
  /** Reads the current provider surface synchronously. */
  resolveWrite(): PolicyWriteResolution;
  /** Authoritative live grants read synchronously at write time. */
  liveGrants(): SessionCredentialGrant[];
};

export type CredentialPolicyOwner = {
  applyLive(expectedAllocationId?: string | null): Promise<CredentialPolicyOutcome>;
  applyCandidate(candidate: SessionCredentialGrant): Promise<CredentialPolicyOutcome>;
  applyRenewalCandidate(
    candidate: SessionCredentialGrant,
    guard: () => RenewalVerdict
  ): Promise<RenewalPolicyOutcome>;
};

function mergeCandidate(
  live: readonly SessionCredentialGrant[],
  candidate: SessionCredentialGrant
): SessionCredentialGrant[] {
  const key = scopeGrantId(candidate);
  return [...live.filter(grant => scopeGrantId(grant) !== key), candidate];
}

function withTimeoutOutcome(
  raw: Promise<void>,
  deadlineMs: number
): Promise<CredentialPolicyResult> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('uncertain');
    }, deadlineMs);
    raw.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('applied');
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('failed');
      }
    );
  });
}

export function createCredentialPolicyOwner(
  options: CredentialPolicyOwnerOptions
): CredentialPolicyOwner {
  const lanes = new Map<string, Promise<void>>();
  /** A timed-out write may still land; no later write is ordered on that lane. */
  const unsafeLanes = new Set<string>();

  async function acquire(laneKey: string): Promise<() => void> {
    const previous = lanes.get(laneKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    lanes.set(
      laneKey,
      previous.then(() => current)
    );
    await previous;
    return release;
  }

  async function write(
    resolveGrants: () => SessionCredentialGrant[] | null,
    expectedAllocationId?: string | null
  ): Promise<CredentialPolicyOutcome> {
    const initial = options.resolveWrite();
    if (expectedAllocationId !== undefined && initial.allocationId !== expectedAllocationId) {
      return { result: 'obsolete', wrote: false, allocationId: expectedAllocationId };
    }
    if (initial.kind !== 'write') {
      return {
        result: initial.kind === 'skip' ? 'applied' : 'failed',
        wrote: false,
        allocationId: initial.allocationId,
      };
    }

    const captured = initial;
    const release = await acquire(captured.allocationId);
    try {
      const latest = options.resolveWrite();
      if (latest.kind !== 'write' || latest.allocationId !== captured.allocationId) {
        // The captured allocation is gone. Never move this operation onto a
        // replacement lane: old work must not write to, or poison, replacement.
        return { result: 'obsolete', wrote: false, allocationId: captured.allocationId };
      }
      if (unsafeLanes.has(captured.allocationId)) {
        return { result: 'failed', wrote: false, allocationId: captured.allocationId };
      }

      const grants = resolveGrants();
      if (grants === null) {
        return { result: 'applied', wrote: false, allocationId: captured.allocationId };
      }
      let raw: Promise<void>;
      try {
        raw = latest.apply(grants);
      } catch (error) {
        raw = Promise.reject(error);
      }
      void raw.then(
        () => undefined,
        () => undefined
      );
      const result = await withTimeoutOutcome(raw, options.deadlineMs());
      if (result === 'uncertain') unsafeLanes.add(captured.allocationId);
      return { result, wrote: true, allocationId: captured.allocationId };
    } finally {
      release();
    }
  }

  return {
    applyLive(expectedAllocationId) {
      return write(() => options.liveGrants(), expectedAllocationId);
    },
    applyCandidate(candidate) {
      return write(() => mergeCandidate(options.liveGrants(), candidate));
    },
    async applyRenewalCandidate(candidate, guard) {
      let verdict: RenewalVerdict | null = null;
      const outcome = await write(() => {
        const decision = guard();
        verdict = decision;
        if (decision !== 'current') return null;
        return mergeCandidate(options.liveGrants(), candidate);
      });
      return { ...outcome, verdict };
    },
  };
}
