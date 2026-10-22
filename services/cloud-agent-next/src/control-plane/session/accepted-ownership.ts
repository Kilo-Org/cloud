import { z } from 'zod';
import type { ControlPlaneTimers } from '../../shared/control-plane-timers.js';
import { CONTROL_PLANE_SESSION_CONTROL_BATCH_LIMIT } from '../../shared/control-plane-protocol.js';

/** KV key for the Session DO's accepted-turn coverage obligation. */
export const ACCEPTED_OWNERSHIP_KEY = 'control_plane_accepted_ownership';
export const ACCEPTED_OWNERSHIP_VERSION = 1;

const entrySchema = z
  .object({
    allocationId: z.string().min(1).max(128),
    /** Immutable acceptance time; a repeated admission never moves it. */
    acceptedAt: z.number().finite().nonnegative().safe(),
    coveredUntil: z.number().finite().nonnegative().safe(),
    nextProbeAt: z.number().finite().nonnegative().safe(),
  })
  .strict();

const cleanupSchema = z
  .object({
    allocationId: z.string().min(1).max(128),
    messageIds: z.array(z.string().min(1).max(128)).min(1),
    retryAt: z.number().finite().nonnegative().safe(),
  })
  .strict();

const ownershipSchema = z
  .object({
    version: z.literal(ACCEPTED_OWNERSHIP_VERSION),
    entries: z.record(z.string().min(1).max(128), entrySchema),
    cleanup: z.array(cleanupSchema),
  })
  .strict();

export type AcceptedOwnershipEntry = z.infer<typeof entrySchema>;
export type AcceptedOwnershipCleanup = z.infer<typeof cleanupSchema>;
export type AcceptedOwnership = z.infer<typeof ownershipSchema>;

export type CoverageProbeBatch = {
  allocationId: string;
  messageIds: string[];
  /** The time the schedule was persisted; a success extends from here. */
  startedAt: number;
};

export type CleanupBatch = CoverageProbeBatch;

export type ExpiredCoverage = {
  allocationId: string;
  messageIds: string[];
};

export function emptyAcceptedOwnership(): AcceptedOwnership {
  return { version: ACCEPTED_OWNERSHIP_VERSION, entries: {}, cleanup: [] };
}

export function parseAcceptedOwnership(raw: unknown): AcceptedOwnership {
  const parsed = ownershipSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyAcceptedOwnership();
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function clone(state: AcceptedOwnership): AcceptedOwnership {
  return {
    version: state.version,
    entries: { ...state.entries },
    cleanup: state.cleanup.map(cleanup => ({ ...cleanup, messageIds: [...cleanup.messageIds] })),
  };
}

/**
 * Start coverage for newly accepted messages. Existing ids keep their original
 * acceptance and deadline, so a repeated admission never extends coverage.
 */
export function acceptCoveredMessages(
  state: AcceptedOwnership,
  messageIds: readonly string[],
  allocationId: string,
  acceptedAt: number,
  timers: ControlPlaneTimers['session']
): AcceptedOwnership {
  if (allocationId.length === 0) return state;
  const next = clone(state);
  const coveredUntil = acceptedAt + timers.acceptedCoverageMs;
  for (const messageId of messageIds) {
    if (next.entries[messageId] !== undefined) continue;
    next.entries[messageId] = {
      allocationId,
      acceptedAt,
      coveredUntil,
      nextProbeAt: acceptedAt + timers.acceptedProbeMs,
    };
  }
  return next;
}

/**
 * Drop coverage for terminal messages without creating a cleanup obligation.
 * Cleanup already recorded for an expired id is kept: it still needs a
 * confirmation that the native turn was abandoned.
 */
export function pruneAcceptedOwnership(
  state: AcceptedOwnership,
  messageIds: readonly string[]
): AcceptedOwnership {
  let changed = false;
  const entries = { ...state.entries };
  for (const messageId of messageIds) {
    if (entries[messageId] === undefined) continue;
    delete entries[messageId];
    changed = true;
  }
  return changed ? { ...state, entries } : state;
}

/**
 * Under-queue scheduling step. Expired coverage leaves the entry map and joins
 * a per-allocation cleanup obligation; due healthy entries are marked probed so
 * the alarm I/O starts with a persisted next deadline. The caller settles
 * `expired` only after persisting this returned state.
 */
export function advanceAcceptedOwnership(
  state: AcceptedOwnership,
  now: number,
  timers: ControlPlaneTimers['session']
): { state: AcceptedOwnership; probes: CoverageProbeBatch[]; expired: ExpiredCoverage[] } {
  const next = clone(state);
  const probesByAllocation = new Map<string, string[]>();
  const expiredByAllocation = new Map<string, string[]>();
  let changed = false;

  for (const [messageId, entry] of Object.entries(next.entries)) {
    if (entry.coveredUntil <= now) {
      delete next.entries[messageId];
      const ids = expiredByAllocation.get(entry.allocationId) ?? [];
      ids.push(messageId);
      expiredByAllocation.set(entry.allocationId, ids);
      changed = true;
      continue;
    }
    if (entry.nextProbeAt <= now) {
      next.entries[messageId] = { ...entry, nextProbeAt: now + timers.acceptedProbeMs };
      const ids = probesByAllocation.get(entry.allocationId) ?? [];
      ids.push(messageId);
      probesByAllocation.set(entry.allocationId, ids);
      changed = true;
    }
  }

  const cleanup = next.cleanup.map(item => ({ ...item, messageIds: [...item.messageIds] }));
  for (const [allocationId, messageIds] of expiredByAllocation) {
    const existing = cleanup.find(item => item.allocationId === allocationId);
    if (existing === undefined) {
      cleanup.push({ allocationId, messageIds: [...messageIds], retryAt: now });
    } else {
      for (const messageId of messageIds) {
        if (!existing.messageIds.includes(messageId)) existing.messageIds.push(messageId);
      }
      existing.retryAt = Math.min(existing.retryAt, now);
    }
  }
  next.cleanup = cleanup;

  const probes = [...probesByAllocation].flatMap(([allocationId, messageIds]) =>
    chunk(messageIds, CONTROL_PLANE_SESSION_CONTROL_BATCH_LIMIT).map(ids => ({
      allocationId,
      messageIds: ids,
      startedAt: now,
    }))
  );
  const expired = [...expiredByAllocation].map(([allocationId, messageIds]) => ({
    allocationId,
    messageIds,
  }));
  return { state: changed ? next : state, probes, expired };
}

/**
 * A successful, explicitly covered response extends only the still-active ids
 * it names. Missing ids, RPC failures and unrelated heartbeats never renew.
 */
export function extendAcceptedCoverage(
  state: AcceptedOwnership,
  batch: CoverageProbeBatch,
  coveredMessageIds: readonly string[],
  timers: ControlPlaneTimers['session']
): AcceptedOwnership {
  const covered = new Set(coveredMessageIds);
  let changed = false;
  const entries = { ...state.entries };
  for (const messageId of batch.messageIds) {
    if (!covered.has(messageId)) continue;
    const entry = entries[messageId];
    if (entry === undefined || entry.allocationId !== batch.allocationId) continue;
    const coveredUntil = Math.max(entry.coveredUntil, batch.startedAt + timers.acceptedCoverageMs);
    if (coveredUntil === entry.coveredUntil) continue;
    entries[messageId] = { ...entry, coveredUntil };
    changed = true;
  }
  return changed ? { ...state, entries } : state;
}

/**
 * Due cleanup obligations. Retry time advances before the I/O, so a failed or
 * deferred abandon retries on a bounded cadence instead of spinning the alarm.
 */
export function selectCleanupRetries(
  state: AcceptedOwnership,
  now: number,
  timers: ControlPlaneTimers['session']
): { state: AcceptedOwnership; batches: CleanupBatch[] } {
  if (state.cleanup.length === 0) return { state, batches: [] };
  const next = clone(state);
  const batches: CleanupBatch[] = [];
  let changed = false;
  for (const cleanup of next.cleanup) {
    if (cleanup.retryAt > now) continue;
    cleanup.retryAt = now + timers.acceptedProbeMs;
    changed = true;
    for (const ids of chunk(cleanup.messageIds, CONTROL_PLANE_SESSION_CONTROL_BATCH_LIMIT)) {
      batches.push({ allocationId: cleanup.allocationId, messageIds: ids, startedAt: now });
    }
  }
  return { state: changed ? next : state, batches };
}

/**
 * Apply one abandon reply. Only ids named in this request are removed, so a
 * stale reply cannot delete a newer expiry that accumulated meanwhile.
 */
export function applyCleanupOutcome(
  state: AcceptedOwnership,
  batch: CleanupBatch,
  outcome: 'abandoned' | 'deferred' | 'absent' | 'failed',
  now: number,
  timers: ControlPlaneTimers['session']
): AcceptedOwnership {
  if (state.cleanup.length === 0) return state;
  const requested = new Set(batch.messageIds);
  const next = clone(state);
  const cleanup: AcceptedOwnershipCleanup[] = [];
  for (const item of next.cleanup) {
    if (item.allocationId !== batch.allocationId) {
      cleanup.push(item);
      continue;
    }
    if (outcome === 'abandoned' || outcome === 'absent') {
      item.messageIds = item.messageIds.filter(messageId => !requested.has(messageId));
    } else {
      item.retryAt = now + timers.acceptedProbeMs;
    }
    if (item.messageIds.length > 0) cleanup.push(item);
  }
  return { ...next, cleanup };
}

/**
 * Remove one retired allocation's obligation. The wrapper for that allocation
 * can no longer be current, so there is no zombie to fence against this route.
 */
export function dropRetiredCleanup(
  state: AcceptedOwnership,
  allocationId: string | undefined
): AcceptedOwnership {
  if (allocationId === undefined) return state;
  const cleanup = state.cleanup.filter(item => item.allocationId !== allocationId);
  return cleanup.length === state.cleanup.length ? state : { ...state, cleanup };
}

export function hasUnresolvedCleanup(
  state: AcceptedOwnership,
  allocationId: string | undefined
): boolean {
  return (
    allocationId !== undefined &&
    state.cleanup.some(item => item.allocationId === allocationId && item.messageIds.length > 0)
  );
}

/** Coverage-owned message ids are excluded from the legacy age backstop. */
export function coverageOwnedMessageIds(state: AcceptedOwnership): ReadonlySet<string> {
  return new Set(Object.keys(state.entries));
}

/** The earliest ownership obligation the alarm must service, or null. */
export function nextAcceptedOwnershipAt(state: AcceptedOwnership): number | null {
  const deadlines: number[] = [];
  for (const entry of Object.values(state.entries)) {
    deadlines.push(entry.nextProbeAt, entry.coveredUntil);
  }
  for (const cleanup of state.cleanup) deadlines.push(cleanup.retryAt);
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}
