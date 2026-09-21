import { describe, expect, it } from 'vitest';
import { loadAllocation, loadAllocationSync, loadSession } from './load.js';
import { ALLOCATION_KEY, storeAllocation, type CanonicalStorage } from './store.js';
import {
  isAllocationRecordKey,
  seedAllocationRecord,
  seedSessionValue,
  type SyncRecordReader,
} from './access.js';
import { decideSession } from '../session/reduce.js';
import { allocationEffect } from '../model/allocation.js';
import { POLICY } from '../schedule.js';

const NOW = 5_000_000;

const legacyRunning = {
  state: 'running',
  providerRef: 'provider-ref-1',
  createIntent: {
    intentId: 'intent-1',
    createdAt: NOW - 5_000,
    allocationName: 'vercel-small',
    vercel: {
      projectId: 'p-1',
      snapshotId: 'snap-1',
      runtimeBuildId: 'build-1',
      runtime: 'node24',
      resources: { vcpus: 2, memory: 4096 },
    },
    containment: { kilocode: true, github: true },
  },
  stopTombstone: null,
  resumable: true,
  containment: { kilocode: true, github: true, providerRef: 'provider-ref-1' },
};

const legacyStopping = {
  state: 'stopping',
  providerRef: 'provider-ref-1',
  createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
  stopTombstone: {
    reason: 'idle',
    attempts: 2,
    createdAt: NOW - 1_000,
    wrapperInstanceId: 'wrapper-1',
  },
  resumable: true,
};

const legacyExhaustedUnknown = {
  state: 'unknown',
  providerRef: 'provider-ref-1',
  createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
  stopTombstone: {
    reason: 'idle',
    attempts: 3,
    createdAt: NOW - 1_000,
    wrapperInstanceId: 'wrapper-1',
  },
  resumable: true,
};

const legacyFailed = {
  state: 'failed',
  providerRef: 'provider-ref-1',
  createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
  stopTombstone: {
    reason: 'environment_failed',
    attempts: 4,
    createdAt: NOW - 2_000,
  },
  resumable: true,
};

const queuedIntent = {
  turn: { type: 'prompt', messageId: 'm1', prompt: 'hi' },
  agent: { mode: 'code', model: 'm' },
};

function storageWith(values: Record<string, unknown>): CanonicalStorage & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: async <T>(key: string): Promise<T | undefined> => {
      reads.push(key);
      return values[key] as T | undefined;
    },
    put: async (key: string, value: unknown) => {
      values[key] = value;
    },
  };
}

describe('canonical load — allocation dispatch', () => {
  it('missing canonical and missing legacy → initial record', async () => {
    const result = await loadAllocation(storageWith({}), true);
    expect(result).toEqual({
      ok: true,
      source: 'initial',
      value: { v: 2, resumable: true, state: { kind: 'stopped', summary: null } },
    });
  });

  it('invalid canonical fails closed without reading the legacy key', async () => {
    const storage = storageWith(
      seedAllocationRecord(
        { [ALLOCATION_KEY]: { v: 2, resumable: true, state: { kind: 'nope' } } },
        legacyRunning
      )
    );
    const result = await loadAllocation(storage);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid_canonical_allocation');
    expect(storage.reads.some(isAllocationRecordKey)).toBe(false);
  });

  it('legacy allocation record converts and preserves fields the lossy schema dropped', async () => {
    const result = await loadAllocation(storageWith(seedAllocationRecord({}, legacyRunning)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('legacy');
    const state = result.value.state;
    expect(state.kind).toBe('allocated');
    if (state.kind !== 'allocated') return;
    expect(state.target.allocationName).toBe('vercel-small');
    expect(state.target.vercel?.projectId).toBe('p-1');
    expect(state.target.vercel?.resources).toEqual({ vcpus: 2, memory: 4096 });
    expect(state.target.containment?.kilocode).toBe(true);
    expect(state.target.resolvedContainment?.providerRef).toBe('provider-ref-1');
    expect(state.target.provider).toBe('vercel');
    expect(state.target.capabilities.persistentWorkspace).toBe(true);
  });

  it('legacy running without a provider reference fails closed', async () => {
    const result = await loadAllocation(
      storageWith(seedAllocationRecord({}, { ...legacyRunning, providerRef: null }))
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_legacy_allocation' });
    expect(result.ok === false && isAllocationRecordKey(result.key)).toBe(true);
  });

  it('legacy stopping preserves the stop tombstone wrapper identity and stop intent', async () => {
    const result = await loadAllocation(storageWith(seedAllocationRecord({}, legacyStopping)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value.state;
    expect(state.kind).toBe('stopping');
    if (state.kind !== 'stopping') return;
    expect(state.step).toBe('destroying');
    expect(state.attempts).toBe(2);
    expect(state.stopIntent.reason).toBe('idle');
    expect(state.stopIntent.wrapperInstanceId).toBe('wrapper-1');
    expect(allocationEffect(state.target.capabilities)).toBe('destroy');
    if (state.step === 'destroying') expect(state.deadlineAt).toBe(NOW - 1_000 + 60_000);
  });

  it('legacy exhausted unknown preserves the stop-attempt count through store→load', async () => {
    const storage = storageWith(seedAllocationRecord({}, legacyExhaustedUnknown));
    const converted = await loadAllocation(storage);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const state = converted.value.state;
    expect(state.kind).toBe('unknown');
    if (state.kind !== 'unknown') return;
    expect(state.attempts).toBe(3);
    expect(state.stopIntent?.reason).toBe('idle');
    expect(state.stopIntent?.wrapperInstanceId).toBe('wrapper-1');
    await storeAllocation(storage, converted.value);
    const reloaded = await loadAllocation(storage);
    expect(reloaded).toEqual({ ok: true, source: 'canonical', value: converted.value });
  });

  it('legacy failed preserves a stop tombstone count', async () => {
    const result = await loadAllocation(storageWith(seedAllocationRecord({}, legacyFailed)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value.state;
    expect(state.kind).toBe('unknown');
    if (state.kind !== 'unknown') return;
    expect(state.attempts).toBe(4);
    expect(state.reason).toBe('legacy_failed');
  });

  it('malformed legacy fails closed', async () => {
    const result = await loadAllocation(
      storageWith(seedAllocationRecord({}, { state: 'running' }))
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_legacy_allocation' });
    expect(result.ok === false && isAllocationRecordKey(result.key)).toBe(true);
  });

  it('legacy foreign v marker fails closed', async () => {
    const result = await loadAllocation(
      storageWith(seedAllocationRecord({}, { ...legacyRunning, v: 2 }))
    );
    expect(result.ok).toBe(false);
  });

  it('canonical allocation blocks legacy fallback', async () => {
    const storage = storageWith(
      seedAllocationRecord(
        { [ALLOCATION_KEY]: { v: 2, resumable: true, state: { kind: 'stopped', summary: null } } },
        legacyRunning
      )
    );
    const result = await loadAllocation(storage);
    expect(result.ok === true && result.source).toBe('canonical');
    expect(storage.reads.some(isAllocationRecordKey)).toBe(false);
  });

  it('legacy conflicting version fails closed but the free 2 is tolerated', async () => {
    const conflict = await loadAllocation(
      storageWith(seedAllocationRecord({}, { ...legacyRunning, version: 3 }))
    );
    expect(conflict.ok).toBe(false);
    const tolerated = await loadAllocation(
      storageWith(seedAllocationRecord({}, { ...legacyRunning, version: 2 }))
    );
    expect(tolerated.ok).toBe(true);
  });
});

describe('canonical load — sync/async parity', () => {
  function syncStorageWith(values: Record<string, unknown>): SyncRecordReader {
    return { get: (key: string) => values[key] };
  }

  const cases: { name: string; values: Record<string, unknown> }[] = [
    {
      name: 'valid canonical',
      values: {
        [ALLOCATION_KEY]: { v: 2, resumable: true, state: { kind: 'stopped', summary: null } },
      },
    },
    {
      name: 'malformed canonical',
      values: { [ALLOCATION_KEY]: { v: 2, resumable: true, state: { kind: 'nope' } } },
    },
    { name: 'legacy-only flat record', values: seedAllocationRecord({}, legacyRunning) },
    { name: 'both absent', values: {} },
  ];

  it.each(cases)('agrees for $name', async ({ values }) => {
    const asyncResult = await loadAllocation(storageWith({ ...values }), true);
    const syncResult = loadAllocationSync(syncStorageWith({ ...values }), true);
    expect(syncResult).toStrictEqual(asyncResult);
  });

  it('valid canonical resolves from the canonical source', () => {
    const result = loadAllocationSync(
      syncStorageWith({
        [ALLOCATION_KEY]: { v: 2, resumable: true, state: { kind: 'stopped', summary: null } },
      })
    );
    expect(result).toMatchObject({ ok: true, source: 'canonical' });
  });

  it('malformed canonical fails closed without reading the legacy key', () => {
    const reads: string[] = [];
    const storage: SyncRecordReader = {
      get: (key: string) => {
        reads.push(key);
        return { [ALLOCATION_KEY]: { v: 2, resumable: true, state: { kind: 'nope' } } }[key];
      },
    };
    const result = loadAllocationSync(storage);
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_canonical_allocation',
      key: ALLOCATION_KEY,
    });
    expect(reads.some(isAllocationRecordKey)).toBe(false);
  });
});

describe('canonical load — session dispatch', () => {
  it('missing → empty aggregate', async () => {
    const result = await loadSession(storageWith({}));
    expect(result).toEqual({
      ok: true,
      source: 'initial',
      value: { binding: { kind: 'unbound' }, messages: [] },
    });
  });

  it('marker-free bare array decodes both row eras and preserves durable metadata', async () => {
    const rows = [
      {
        version: 2,
        messageId: 'm1',
        state: 'queued',
        intent: queuedIntent,
        queuedAt: 90,
        deliveryDeadlineAt: 111,
        attachFailures: 1,
        promptFailures: 0,
        cancellation: { operationId: 'cancel-1', deadlineAt: 120 },
      },
      {
        messageId: 'm2',
        state: 'failed',
        turn: { type: 'prompt', messageId: 'm2', prompt: 'legacy' },
        queuedAt: 95,
        failedReason: 'boom',
        terminalAt: 222,
      },
    ];
    const result = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('legacy');
    expect(result.value.messages).toHaveLength(2);
    const first = result.value.messages[0];
    expect(first.state.kind).toBe('queued');
    expect(first.state.queuedAt).toBe(90);
    expect(first.cancellation).toEqual({ operationId: 'cancel-1', deadlineAt: 120 });
    const second = result.value.messages[1];
    expect(second.state.kind).toBe('failed');
    expect(second.state.kind === 'failed' && second.state.reason).toBe('boom');
    expect(second.state.kind === 'failed' && second.state.at).toBe(222);
    // A legacy payload with no marker is *unresolved* (a later freeze may still
    // resolve it), not permanently invalid.
    expect(second.state.intent).toBeNull();
    expect(second.state.legacyInvalidIntent).toBeUndefined();
    const legacyTurn = second.state.legacy?.turn;
    expect(legacyTurn?.type === 'prompt' && legacyTurn.prompt).toBe('legacy');
  });

  it('maps a legacy completed root gate result into the nested state', async () => {
    const rows = [
      {
        messageId: 'm1',
        state: 'completed',
        turn: { type: 'prompt', messageId: 'm1', prompt: 'review' },
        terminalAt: 222,
        gateResult: 'fail',
      },
      {
        messageId: 'm2',
        state: 'completed',
        turn: { type: 'prompt', messageId: 'm2', prompt: 'review' },
        terminalAt: 223,
      },
    ];
    const result = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('legacy');
    const withGate = result.value.messages[0]?.state;
    expect(withGate?.kind === 'completed' && withGate.gateResult).toBe('fail');
    const withoutGate = result.value.messages[1]?.state;
    expect(withoutGate).toBeDefined();
    expect(withoutGate).not.toHaveProperty('gateResult');
  });

  it('maps legacy failed root assistant facts into the nested state', async () => {
    const rows = [
      {
        messageId: 'm1',
        state: 'failed',
        turn: { type: 'prompt', messageId: 'm1', prompt: 'boom' },
        terminalAt: 222,
        assistantReason: 'rate_limited',
        providerOwnership: 'unknown',
      },
      {
        messageId: 'm2',
        state: 'failed',
        turn: { type: 'prompt', messageId: 'm2', prompt: 'boom' },
        terminalAt: 223,
      },
    ];
    const result = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('legacy');
    const withFacts = result.value.messages[0]?.state;
    expect(withFacts?.kind === 'failed' && withFacts.assistantReason).toBe('rate_limited');
    expect(withFacts?.kind === 'failed' && withFacts.providerOwnership).toBe('unknown');
    const withoutFacts = result.value.messages[1]?.state;
    expect(withoutFacts).toBeDefined();
    expect(withoutFacts).not.toHaveProperty('assistantReason');
    expect(withoutFacts).not.toHaveProperty('providerOwnership');
  });

  it('preserves a legacy terminal acceptedAt and its retained delivery identity', async () => {
    const rows = [
      {
        messageId: 'm1',
        state: 'failed',
        turn: { type: 'prompt', messageId: 'm1', prompt: 'boom' },
        queuedAt: 95,
        acceptedAt: 100,
        failedReason: 'boom',
        terminalAt: 222,
        wrapperInstanceId: 'w-1',
        preparationAttemptId: 'attempt-1',
      },
    ];
    const result = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value.messages[0]?.state;
    if (state?.kind !== 'failed') throw new Error('Expected a failed terminal state');
    // `acceptedAt` must not collapse into the terminal timestamp.
    expect(state).toMatchObject({
      kind: 'failed',
      at: 222,
      acceptedAt: 100,
      wrapperInstanceId: 'w-1',
      preparationAttemptId: 'attempt-1',
    });
    expect(state.acceptedAt).not.toBe(state.at);
  });

  it('legacy accepted rows resolve against the decoded allocation and accept its real loss proof', async () => {
    const allocation = await loadAllocation(storageWith(seedAllocationRecord({}, legacyRunning)));
    expect(allocation.ok).toBe(true);
    if (!allocation.ok || allocation.value.state.kind !== 'allocated') {
      throw new Error('expected a decoded allocated record');
    }
    const incarnation = allocation.value.state.health.incarnation;
    expect(incarnation).toBe('provider-ref-1');

    const rows = [
      {
        version: 2,
        messageId: 'm1',
        state: 'accepted',
        intent: queuedIntent,
        acceptedAt: 100,
        wrapperInstanceId: 'w-1',
      },
    ];

    // Without authoritative migration context the binding must stay unresolved;
    // it must never fabricate an incarnation from the wrapper identity.
    const unresolved = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(unresolved.ok).toBe(true);
    if (!unresolved.ok) return;
    expect(unresolved.value.binding.kind).toBe('unresolved');

    const handle = { incarnation, wrapper: 'w-1', epoch: 0 };
    const result = await loadSession(storageWith(seedSessionValue({}, rows)), {
      legacyBindingHandle: handle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.binding).toEqual({ kind: 'bound', handle });
    const accepted = result.value.messages[0];
    expect(accepted?.state.kind === 'accepted' && accepted.state.executionDeadlineAt).toBe(
      100 + POLICY.acceptedExecutionBoundMs
    );

    // The allocation's real loss proof carries the allocation incarnation, with no
    // wrapper; it must be accepted and terminalize the accepted work.
    const decision = decideSession(
      result.value,
      {
        type: 'STOPPED',
        proof: {
          effect: 'destroy',
          at: NOW,
          providerRef: 'provider-ref-1',
          incarnation,
          reason: 'health_unhealthy_absent',
        },
        reason: 'health_unhealthy_absent',
      },
      NOW
    );
    expect(decision?.state.binding.kind).toBe('unbound');
    expect(decision?.state.messages[0]?.state.kind).toBe('failed');
  });

  it('legacy proof fixture with error.admission converts and preserves the admission', async () => {
    const rows = [
      {
        version: 2,
        messageId: 'm1',
        state: 'queued',
        intent: queuedIntent,
        queuedAt: 90,
        deliveryDeadlineAt: 111,
        attachFailures: 0,
        promptFailures: 0,
        operations: {
          prompt: {
            authorization: {
              operation: 'session.prompt',
              operationId: 'op',
              messageId: 'm1',
              session: { sessionId: 's', kiloSessionId: 'k', directory: '/d' },
              wrapperInstanceId: 'w-1',
              dispatchDeadlineAt: 100,
            },
            dispatched: true,
            result: {
              ok: false,
              error: {
                code: 'not_admitted',
                message: 'no',
                retryable: false,
                admission: 'not-admitted',
              },
            },
          },
        },
      },
    ];
    const result = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('legacy');
    const proof = result.value.messages[0]?.proofs?.prompt;
    expect(proof?.result?.ok).toBe(false);
    expect(proof?.result?.ok === false && proof.result.error.admission).toBe('not-admitted');
  });

  it('canonical envelope decodes and preserves proofs including admission', async () => {
    const envelope = {
      v: 2,
      binding: { kind: 'bound', handle: { incarnation: 'inc-1', wrapper: 'w-1', epoch: 1 } },
      messages: [
        {
          messageId: 'm1',
          state: {
            kind: 'queued',
            intent: queuedIntent,
            deliveryStep: 'waiting',
            deadlineAt: null,
            attachFailures: 0,
            promptFailures: 0,
          },
          proofs: {
            prompt: {
              authorization: {
                operation: 'session.prompt',
                operationId: 'op',
                messageId: 'm1',
                session: { sessionId: 's', kiloSessionId: 'k', directory: '/d' },
                wrapperInstanceId: 'w-1',
                dispatchDeadlineAt: 1,
              },
              dispatched: true,
              result: {
                ok: false,
                error: {
                  code: 'not_admitted',
                  message: 'no',
                  retryable: false,
                  admission: 'not-admitted',
                },
              },
            },
          },
        },
      ],
    };
    const result = await loadSession(storageWith(seedSessionValue({}, envelope)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('canonical');
    const proof = result.value.messages[0]?.proofs?.prompt;
    expect(proof?.result?.ok).toBe(false);
    expect(proof?.result?.ok === false && proof.result.error.admission).toBe('not-admitted');
  });

  it('rejects a canonical envelope with an accepted message but no binding', async () => {
    const envelope = {
      v: 2,
      binding: { kind: 'unbound' },
      messages: [
        {
          messageId: 'm1',
          state: { kind: 'accepted', intent: queuedIntent, acceptedAt: 1, executionDeadlineAt: 2 },
        },
      ],
    };
    const result = await loadSession(storageWith(seedSessionValue({}, envelope)));
    expect(result.ok).toBe(false);
  });

  it('container foreign v is rejected', async () => {
    const result = await loadSession(
      storageWith(seedSessionValue({}, { v: 1, binding: { kind: 'unbound' }, messages: [] }))
    );
    expect(result.ok === false && result.reason).toBe('foreign_marker');
  });

  it('bare array row owning v is rejected', async () => {
    const result = await loadSession(
      storageWith(seedSessionValue({}, [{ messageId: 'm1', state: 'queued', v: 2 }]))
    );
    expect(result.ok === false && result.reason).toBe('invalid_legacy_session');
  });

  it('bare array container owning v is rejected', async () => {
    const rows: unknown[] & { v?: number } = [];
    rows.v = 2;
    const result = await loadSession(storageWith(seedSessionValue({}, rows)));
    expect(result.ok === false && result.reason).toBe('foreign_marker');
  });

  it('canonical message row owning v is rejected', async () => {
    const envelope = {
      v: 2,
      binding: { kind: 'unbound' },
      messages: [
        {
          messageId: 'm1',
          v: 2,
          state: {
            kind: 'queued',
            intent: queuedIntent,
            deliveryStep: 'waiting',
            deadlineAt: null,
            attachFailures: 0,
            promptFailures: 0,
          },
        },
      ],
    };
    const result = await loadSession(storageWith(seedSessionValue({}, envelope)));
    expect(result.ok).toBe(false);
  });

  it('unknown shapes fail closed', async () => {
    for (const value of ['nope', 42, { v: 2 }, { binding: { kind: 'unbound' } }, null]) {
      const result = await loadSession(storageWith(seedSessionValue({}, value)));
      expect(result.ok).toBe(false);
    }
  });
});
