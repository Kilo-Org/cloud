/**
 * The control DO's single alarm. It composes `alarmAt` from the canonical
 * allocation deadline (`sandbox-state/schedule.ts`) plus the infrastructure
 * anchors the allocation machine does not own (the socket-handshake and
 * credential deadlines), and it is the only module that calls `setAlarm` /
 * `deleteAlarm`.
 *
 * The infrastructure anchors are owned here, under their own storage key. The
 * only read of the legacy deadline table is the one-time pre-cutover import
 * below, which never writes that key and runs once before the alarm owner
 * mutates its own anchors.
 */
import { z } from 'zod';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { allocationAlarmAt } from '../sandbox-state/schedule.js';

export const CONTROL_ALARM_ANCHORS_KEY = 'control_alarm_anchors';

export const LEGACY_CONTROL_DEADLINES_KEY = 'deadlines';

/**
 * The legacy pre-cutover anchor fields. The legacy writer stored numbers only;
 * this is a narrow cast for the raw storage read, not a runtime guard.
 */
type LegacyDeadlineAnchors = {
  socketHandshake?: number;
  credentialExpiry?: number;
};

export type AlarmScheduler = {
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

/** The two infrastructure anchors the canonical allocation machine does not own. */
export type ControlAlarmAnchorId = 'credentialExpiry' | 'socketHandshake';

export type ControlAlarmAnchorState = {
  credentialExpiryAt: number | null;
  socketHandshakeAt: number | null;
};

export type ControlAlarmAnchors = {
  /** Canonical allocation aggregate, or `null` before first load. */
  allocation: AllocationRecord | null;
  credentialExpiryAt: number | null;
  socketHandshakeAt: number | null;
};

type AnchorStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

const controlAlarmAnchorStateSchema = z.object({
  credentialExpiryAt: z.number().int().nonnegative().nullable(),
  socketHandshakeAt: z.number().int().nonnegative().nullable(),
});

export function emptyControlAlarmAnchors(): ControlAlarmAnchorState {
  return { credentialExpiryAt: null, socketHandshakeAt: null };
}

export function controlAlarmAnchorAt(
  anchors: ControlAlarmAnchorState,
  id: ControlAlarmAnchorId
): number | null {
  return id === 'credentialExpiry' ? anchors.credentialExpiryAt : anchors.socketHandshakeAt;
}

export async function loadControlAlarmAnchors(
  storage: AnchorStorage
): Promise<ControlAlarmAnchorState> {
  const parsed = controlAlarmAnchorStateSchema.safeParse(
    await storage.get(CONTROL_ALARM_ANCHORS_KEY)
  );
  return parsed.success ? parsed.data : emptyControlAlarmAnchors();
}

/**
 * One-time import of the pre-cutover `socketHandshake`/`credentialExpiry`
 * anchors into the alarm owner's key. It returns immediately once the marker
 * exists; otherwise it carries only future anchors and persists the result even
 * when empty, so a reconstructed object never re-reads the legacy table. The
 * read is raw and unchecked, matching the pre-cutover reader exactly: a future
 * timestamp stored as a string passes the `>` predicate and is persisted
 * unchanged. It never writes the legacy key and arms nothing by itself.
 */
export async function importLegacyControlAlarmAnchors(
  storage: AnchorStorage,
  now: number
): Promise<void> {
  if ((await storage.get(CONTROL_ALARM_ANCHORS_KEY)) !== undefined) return;
  const legacy = (await storage.get(LEGACY_CONTROL_DEADLINES_KEY)) as
    | LegacyDeadlineAnchors
    | undefined;
  const anchors: ControlAlarmAnchorState = {
    socketHandshakeAt:
      legacy?.socketHandshake !== undefined && legacy.socketHandshake > now
        ? legacy.socketHandshake
        : null,
    credentialExpiryAt:
      legacy?.credentialExpiry !== undefined && legacy.credentialExpiry > now
        ? legacy.credentialExpiry
        : null,
  };
  await storage.put(CONTROL_ALARM_ANCHORS_KEY, anchors);
}

export async function setControlAlarmAnchor(
  storage: AnchorStorage,
  id: ControlAlarmAnchorId,
  at: number | null
): Promise<ControlAlarmAnchorState> {
  const current = await loadControlAlarmAnchors(storage);
  const next: ControlAlarmAnchorState =
    id === 'credentialExpiry'
      ? { ...current, credentialExpiryAt: at }
      : { ...current, socketHandshakeAt: at };
  await storage.put(CONTROL_ALARM_ANCHORS_KEY, next);
  return next;
}

/** Infrastructure anchors that are due at `now`, earliest first. */
export function dueControlAlarmAnchors(
  anchors: ControlAlarmAnchorState,
  now: number
): ControlAlarmAnchorId[] {
  const due: Array<{ id: ControlAlarmAnchorId; at: number }> = [];
  if (anchors.credentialExpiryAt !== null && anchors.credentialExpiryAt <= now) {
    due.push({ id: 'credentialExpiry', at: anchors.credentialExpiryAt });
  }
  if (anchors.socketHandshakeAt !== null && anchors.socketHandshakeAt <= now) {
    due.push({ id: 'socketHandshake', at: anchors.socketHandshakeAt });
  }
  return due.sort((a, b) => a.at - b.at).map(entry => entry.id);
}

/** Earliest eligible anchor; `null` means no alarm should be armed. */
export function composeControlAlarmAt(anchors: ControlAlarmAnchors): number | null {
  const candidates: number[] = [];
  if (anchors.allocation !== null) {
    const allocationDeadline = allocationAlarmAt(anchors.allocation);
    if (allocationDeadline !== null) candidates.push(allocationDeadline);
  }
  if (anchors.credentialExpiryAt !== null) candidates.push(anchors.credentialExpiryAt);
  if (anchors.socketHandshakeAt !== null) candidates.push(anchors.socketHandshakeAt);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** Apply the composed alarm through the scheduler; returns the armed time. */
export async function scheduleControlAlarm(
  scheduler: AlarmScheduler,
  anchors: ControlAlarmAnchors
): Promise<number | null> {
  const at = composeControlAlarmAt(anchors);
  if (at === null) {
    await scheduler.deleteAlarm();
    return null;
  }
  await scheduler.setAlarm(at);
  return at;
}
