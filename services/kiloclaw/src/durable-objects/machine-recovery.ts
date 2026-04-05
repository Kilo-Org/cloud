import type { FlyMachine, FlyMachineState } from '../fly/types';
import { ALARM_INTERVAL_IDLE_MS } from '../config';

/** Cooldown between metadata recovery attempts (1 alarm cycle at idle cadence). */
export const METADATA_RECOVERY_COOLDOWN_MS = ALARM_INTERVAL_IDLE_MS;

/** Cooldown after getVolume finds no attached machine during destroy recovery. */
export const BOUND_MACHINE_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

/** States that indicate the machine is dead and should be ignored for recovery. */
export const DEAD_STATES: ReadonlySet<FlyMachineState> = new Set(['destroyed', 'destroying']);

/** Terminal non-running states for live check. Transitional states (starting, stopping, replacing)
 *  are intentionally excluded to avoid UI flicker during normal operations. */
export const TERMINAL_STOPPED_STATES: ReadonlySet<FlyMachineState> = new Set([
  'stopped',
  'created',
  'destroyed',
  'suspended',
  'failed',
]);

/**
 * Priority order for picking a machine to recover.
 * Lower index = higher preference. `started` is best, then `starting`, etc.
 */
const STATE_PRIORITY: ReadonlyMap<FlyMachineState, number> = new Map([
  ['started', 0],
  ['starting', 1],
  ['stopped', 2],
  ['created', 3],
  ['stopping', 4],
  ['replacing', 5],
  ['updating', 6],
  ['suspended', 7],
  ['failed', 8],
]);

/**
 * Given a list of machines from Fly's metadata query, pick the best candidate
 * for recovery. Returns null if no live machines found.
 *
 * Selection rules:
 * 1. Ignore destroyed/destroying machines.
 * 2. Prefer started > starting > stopped > created > others.
 * 3. Tie-break by newest updated_at.
 */
export function selectRecoveryCandidate(machines: FlyMachine[]): FlyMachine | null {
  const live = machines.filter(m => !DEAD_STATES.has(m.state));
  if (live.length === 0) return null;

  live.sort((a, b) => {
    const pa = STATE_PRIORITY.get(a.state) ?? 99;
    const pb = STATE_PRIORITY.get(b.state) ?? 99;
    if (pa !== pb) return pa - pb;
    // Tie-break: newest updated_at first
    return b.updated_at.localeCompare(a.updated_at);
  });

  return live[0];
}

/**
 * Extract the volume ID from a machine's mount config at /root, if present.
 */
export function volumeIdFromMachine(machine: FlyMachine): string | null {
  const rootMount = (machine.config?.mounts ?? []).find(m => m.path === '/root');
  return rootMount?.volume ?? null;
}
