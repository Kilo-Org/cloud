/**
 * Allocation aggregate controller. The single writer and single dispatcher for
 * the allocation machine: every event — including health events — is handed to
 * `decideAllocation`, which delegates health internally (`delegatedHealth` /
 * `applyHealth`) and applies the allocation-level consequence once. The
 * controller loads the canonical record, persists the decided record through
 * `storeAllocation`, and returns the commands for the effect runner. It performs
 * no provider I/O and makes no transition decision of its own.
 *
 * It also owns the acquisition/incarnation fencing (`bindAcquisition`
 * semantics). A request id binds to exactly one allocation identity; a changed
 * deadline throws an ordinary `Error` (matching the live
 * `SandboxControl.bindAcquisition`). A mismatched receipt throws
 * `SandboxAcquisitionSupersededError` when a fresh acquisition would bind the
 * current allocation (live and identity-bearing) and `SandboxAcquisitionLostError`
 * otherwise, so a replayed request never starts a second create and a
 * replacement allocation is recoverable rather than terminal.
 */
import { z } from 'zod';
import type { Command } from '../sandbox-state/commands.js';
import type { AllocationInputEvent } from '../sandbox-state/events.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { decideAllocation } from '../sandbox-state/allocation/reduce.js';
import { loadAllocation } from '../sandbox-state/persist/load.js';
import { storeAllocation, type CanonicalStorage } from '../sandbox-state/persist/store.js';
import {
  SandboxAcquisitionLostError,
  SandboxAcquisitionSupersededError,
} from '../shared/sandbox-control-protocol.js';
import {
  allocationTransitionChanged,
  buildAllocationTransition,
  type AllocationTransition,
} from './allocation-transition.js';

/** Receipt key used by the live DO today; kept identical for the cutover. */
export const ACQUISITION_RECEIPTS_KEY = 'acquisition_receipts';

/**
 * Bounded record of requests that reopened the current exhausted cleanup. It is
 * scoped to one cleanup allocation and dropped with the request deadline, so a
 * request's own polls wait instead of restarting the ladder while a different
 * request may reopen it. Kept apart from allocation receipts so a request that
 * consumed a cleanup can still bind to the next allocation.
 */
export const ACQUISITION_CLEANUP_REOPENS_KEY = 'acquisition_cleanup_reopens';

/**
 * Upper bound on retained reopen markers (they also expire by deadline). A full
 * ledger fails closed: a new request waits instead of evicting a live marker.
 */
export const MAX_ACQUISITION_CLEANUP_REOPENS = 32;

export type AllocationIdentity = { kind: 'intent' | 'provider'; id: string };

/** A session's acquisition demand: one request id, one delivery deadline. */
export type AllocationAcquisition = { id: string; deadlineAt: number };

const acquisitionReceiptsSchema = z.array(
  z.object({
    id: z.string().min(1).max(128),
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    allocation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('intent'), id: z.string().min(1) }),
      z.object({ kind: z.literal('provider'), id: z.string().min(1) }),
    ]),
  })
);

const cleanupReopensSchema = z.array(
  z.object({
    id: z.string().min(1).max(128),
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    allocationId: z.string().min(1),
  })
);

export class AllocationLoadError extends Error {
  constructor(
    readonly reason: string,
    readonly key: string
  ) {
    super(`Allocation load failed: ${reason} (${key})`);
    this.name = 'AllocationLoadError';
  }
}

export type AllocationControllerDeps = {
  storage: CanonicalStorage;
  /** Injected clock; callers may override per dispatch for determinism. */
  now?: () => number;
  /** Legacy-migration flag for a first-boot record. */
  resumable?: boolean;
  receiptsKey?: string;
  cleanupReopensKey?: string;
  /**
   * The single impure owner of the recovery episode id: mints one uuid for a
   * recovery-opening event that lacks one. Defaults to `crypto.randomUUID`.
   */
  mintEpisodeId?: () => string;
  /**
   * Optional sink for a committed, non-no-op transition. Called after the store.
   * Assertion-free: a failure inside the predicate, the builder or this callback
   * must never block the committed decision's commands.
   */
  onTransition?: (transition: AllocationTransition) => void;
};

export type AllocationDecision = {
  state: AllocationRecord;
  commands: Command[];
  deadlineAt: number | null;
};

export type AllocationController = {
  load(): Promise<AllocationRecord>;
  dispatch(event: AllocationInputEvent, now?: number): Promise<AllocationDecision | undefined>;
  bindAcquisition(
    record: AllocationRecord,
    acquisition: AllocationAcquisition,
    now?: number
  ): Promise<boolean>;
  /**
   * Acquisition-owner guard for an exhausted `check_required` cleanup. Returns
   * `true` when this request already reopened the cleanup's current episode, so
   * its later polls must `wait`; `false` for a fresh request, which is recorded
   * and may advance. The record is scoped to the cleanup's allocation and
   * bounded by the request deadline plus [MAX_ACQUISITION_CLEANUP_REOPENS]. A
   * full ledger fails closed: a new request `wait`s rather than evicting a live
   * replay marker, and advances only once a slot expires.
   */
  reopenCleanup(
    record: AllocationRecord,
    acquisition: AllocationAcquisition,
    now?: number
  ): Promise<boolean>;
};

/** `stopped` has no identity; otherwise the intent id, then the provider ref. */
export function allocationIdentity(record: AllocationRecord): AllocationIdentity | undefined {
  if (record.state.kind === 'stopped') return undefined;
  const createIntent = record.state.createIntent;
  if (createIntent !== null) return { kind: 'intent', id: createIntent.intentId };
  const providerRef = record.state.target?.providerRef ?? null;
  return providerRef === null ? undefined : { kind: 'provider', id: providerRef };
}

/** A live allocation accepts reuse: creating or allocated, with no stop tombstone. */
export function isLiveAllocation(record: AllocationRecord): boolean {
  return record.state.kind === 'creating' || record.state.kind === 'allocated';
}

/** The allocation identity a `stopping` cleanup belongs to. */
export function cleanupAllocationId(record: AllocationRecord): string | undefined {
  return record.state.kind === 'stopping' ? record.state.createIntent.intentId : undefined;
}

/**
 * Attach the minted episode id at the single impure dispatch boundary. Only the
 * four recovery-opening event variants are touched, and only when they lack an
 * id, so a retried dispatch of the same event keeps the first id and every
 * attempt in the episode reuses it.
 */
function withEpisodeId(event: AllocationInputEvent, mint: () => string): AllocationInputEvent {
  switch (event.type) {
    case 'CONNECTED':
    case 'HEARTBEAT':
    case 'HEALTH_OBSERVED':
    case 'DEADLINE':
      return event.episodeId !== undefined ? event : { ...event, episodeId: mint() };
    default:
      return event;
  }
}

/**
 * Report one committed decision. The predicate, the builder and the injected
 * callback all run inside the guard: a comparison, build or callback failure
 * must never block the commands the stored decision already committed.
 */
function reportAllocationTransition(
  deps: AllocationControllerDeps,
  from: AllocationRecord,
  decision: AllocationDecision,
  event: AllocationInputEvent,
  at: number
): void {
  const onTransition = deps.onTransition;
  if (onTransition === undefined) return;
  try {
    if (!allocationTransitionChanged(from, decision.state, decision.commands)) return;
    onTransition(buildAllocationTransition(from, decision.state, event, decision.deadlineAt, at));
  } catch {
    return;
  }
}

export function createAllocationController(deps: AllocationControllerDeps): AllocationController {
  const clock = deps.now ?? (() => Date.now());
  const receiptsKey = deps.receiptsKey ?? ACQUISITION_RECEIPTS_KEY;
  const cleanupReopensKey = deps.cleanupReopensKey ?? ACQUISITION_CLEANUP_REOPENS_KEY;
  const mintEpisodeId = deps.mintEpisodeId ?? (() => crypto.randomUUID());

  async function load(): Promise<AllocationRecord> {
    const result = await loadAllocation(deps.storage, deps.resumable ?? false);
    if (!result.ok) throw new AllocationLoadError(result.reason, result.key);
    return result.value;
  }

  return {
    load,

    async dispatch(event, now) {
      const at = now ?? clock();
      const record = await load();
      const effectiveEvent = withEpisodeId(event, mintEpisodeId);
      const decision = decideAllocation(record, effectiveEvent, at);
      if (decision === undefined) return undefined;
      await storeAllocation(deps.storage, decision.state);
      reportAllocationTransition(deps, record, decision, effectiveEvent, at);
      return {
        state: decision.state,
        commands: decision.commands,
        deadlineAt: decision.deadlineAt,
      };
    },

    async bindAcquisition(record, acquisition, now) {
      const at = now ?? clock();
      if (at >= acquisition.deadlineAt) throw new Error('Sandbox acquisition expired');

      const raw = await deps.storage.get<unknown>(receiptsKey);
      const stored = raw === undefined ? [] : acquisitionReceiptsSchema.parse(raw);
      const receipts = stored.filter(receipt => receipt.deadlineAt > at);
      const receipt = stored.find(candidate => candidate.id === acquisition.id);
      const identity = allocationIdentity(record);
      // `bindable` means live and identity-bearing: the same condition the
      // fresh-bind path below requires to insert a receipt, and the one used to
      // classify a stale receipt's mismatch. The canonical model subsumes the
      // legacy native-retirement fence: a fenced allocation is `stopping` or
      // `unknown`, so it is not live.
      const available = isLiveAllocation(record);
      const bindable = available && identity !== undefined;
      if (receipt) {
        if (receipt.deadlineAt !== acquisition.deadlineAt) {
          throw new Error('Sandbox acquisition deadline changed');
        }
        if (
          !identity ||
          receipt.allocation.kind !== identity.kind ||
          receipt.allocation.id !== identity.id
        ) {
          throw bindable
            ? new SandboxAcquisitionSupersededError()
            : new SandboxAcquisitionLostError();
        }
      }
      if (!receipt && available) {
        if (!identity) throw new Error('Sandbox allocation identity is unavailable');
        receipts.push({ ...acquisition, allocation: identity });
      }
      if (receipts.length !== stored.length || (!receipt && available)) {
        await deps.storage.put(receiptsKey, receipts);
      }
      return receipt !== undefined || available;
    },

    async reopenCleanup(record, acquisition, now) {
      const at = now ?? clock();
      if (at >= acquisition.deadlineAt) throw new Error('Sandbox acquisition expired');
      const allocationId = cleanupAllocationId(record);
      if (allocationId === undefined) return false;

      const raw = await deps.storage.get<unknown>(cleanupReopensKey);
      const stored = raw === undefined ? [] : cleanupReopensSchema.parse(raw);
      // Drop expired markers and markers for a superseded cleanup: only the
      // current cleanup episode can be reopened by the same request id.
      const current = stored.filter(
        marker => marker.deadlineAt > at && marker.allocationId === allocationId
      );
      const existing = current.find(marker => marker.id === acquisition.id);
      if (existing) {
        if (existing.deadlineAt !== acquisition.deadlineAt) {
          throw new Error('Sandbox acquisition deadline changed');
        }
        if (current.length !== stored.length) {
          await deps.storage.put(cleanupReopensKey, current);
        }
        return true;
      }

      // Fail closed when every slot is occupied by a live marker: the ledger
      // keeps its protection rather than evicting an active replay marker, which
      // would let that request restart the exhausted ladder. A genuinely
      // different request advances only once a slot is free (or expires).
      if (current.length >= MAX_ACQUISITION_CLEANUP_REOPENS) {
        if (current.length !== stored.length) {
          await deps.storage.put(cleanupReopensKey, current);
        }
        return true;
      }

      const next = [
        ...current,
        { id: acquisition.id, deadlineAt: acquisition.deadlineAt, allocationId },
      ];
      await deps.storage.put(cleanupReopensKey, next);
      return false;
    },
  };
}
