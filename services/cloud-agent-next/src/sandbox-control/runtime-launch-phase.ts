import {
  RUNTIME_INSTALLER_EXIT,
  type RuntimeLaunchInstallerCode,
  type RuntimeLaunchReceipt,
  parseRuntimeLaunchReceipt,
  runtimeLaunchReceiptPath,
} from './runtime-launch-receipt.js';

/**
 * Launch phase reconciliation. The launch writes one bounded receipt under the
 * reserved root before it either execs the supervisor (handoff) or exits with a
 * typed installer code.
 *
 * The receipt is the phase authority: a strict receipt whose `launchId` is this
 * launch's id decides success or failure, read before the clock. A known-terminal
 * observation never changes a valid receipt's reason. The clock owns the outcome
 * only when no valid receipt exists: at or past the deadline the outcome is
 * `deadline`, and a terminal process with no valid receipt is a generic
 * `bootstrap-failed`. An exit number is never mapped to an artifact reason.
 */

/** How often the launch polls its receipt and process state while starting. */
export const RUNTIME_RECEIPT_POLL_MS = 250;

export type RuntimeLaunchProcessStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'error';

export type RuntimeLaunchProcessProbe = {
  getProcess(id: string): Promise<{ status: RuntimeLaunchProcessStatus; exitCode?: number } | null>;
};

export type RuntimeLaunchReceiptReader = {
  readFile(
    path: string,
    options: { encoding: 'utf-8' }
  ): Promise<{ success: boolean; content: string }>;
};

export type RuntimeLaunchReceiptRead =
  | { kind: 'receipt'; receipt: RuntimeLaunchReceipt }
  /** The file does not exist yet, or the read is not proof. */
  | { kind: 'absent' }
  /** The file exists but fails the strict bounded schema or the id check. */
  | { kind: 'invalid' };

/**
 * The launch outcome. `installer-failed` is a valid receipt's own closed code;
 * `deadline` is the installer's deadline code or the clock when no valid receipt
 * exists; a generic `bootstrap-failed` is never an artifact reason.
 * `ownership-lost` is a definite refusal or retirement: the launch no longer
 * owns its token, so observation ends at once instead of polling to the bound.
 */
export type RuntimeLaunchOutcome =
  | { kind: 'handoff' }
  | { kind: 'installer-failed'; code: RuntimeLaunchInstallerCode }
  | { kind: 'deadline' }
  | { kind: 'ownership-lost' }
  | { kind: 'bootstrap-failed' };

export type RuntimeLaunchTerminal = { kind: 'running' } | { kind: 'terminal' };

/** Test seam: production uses the ambient clock and a real sleep. */
export type RuntimeLaunchPhaseClock = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A terminal process status never becomes running again. */
export function isRuntimeLaunchTerminal(status: RuntimeLaunchProcessStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed' || status === 'error';
}

/** Read only this launch's receipt file, strictly and bounded. */
export async function readRuntimeLaunchReceipt(
  reader: RuntimeLaunchReceiptReader,
  path: string,
  launchId: string
): Promise<RuntimeLaunchReceiptRead> {
  let content: string;
  try {
    const result = await reader.readFile(path, { encoding: 'utf-8' });
    if (!result.success) return { kind: 'absent' };
    content = result.content;
  } catch {
    return { kind: 'absent' };
  }
  try {
    return { kind: 'receipt', receipt: parseRuntimeLaunchReceipt(content, launchId) };
  } catch {
    return { kind: 'invalid' };
  }
}

async function readTerminal(
  probe: RuntimeLaunchProcessProbe,
  processId: string
): Promise<RuntimeLaunchTerminal> {
  try {
    const info = await probe.getProcess(processId);
    if (info === null || !isRuntimeLaunchTerminal(info.status)) return { kind: 'running' };
    return { kind: 'terminal' };
  } catch {
    return { kind: 'running' };
  }
}

/**
 * Classify one valid current-launch receipt. The receipt is the phase authority,
 * so no process DTO and no clock is consulted here. Code 75 is the installer's
 * own deadline, which stays the clock's reason.
 */
function classifyReceipt(receipt: RuntimeLaunchReceipt): RuntimeLaunchOutcome {
  if (receipt.outcome === 'handoff') return { kind: 'handoff' };
  if (receipt.code === RUNTIME_INSTALLER_EXIT.deadlineExceeded) return { kind: 'deadline' };
  return { kind: 'installer-failed', code: receipt.code };
}

/**
 * Observe the bounded startup window. A valid current-launch receipt wins
 * immediately; otherwise the clock and a bounded fresh DTO decide, and a dead
 * process with no valid receipt fails generically and promptly.
 */
export async function observeRuntimeLaunchPhase(
  reader: RuntimeLaunchReceiptReader,
  probe: RuntimeLaunchProcessProbe,
  processId: string,
  launchId: string,
  deadlineAt: number,
  clock: RuntimeLaunchPhaseClock = {}
): Promise<RuntimeLaunchOutcome> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? defaultSleep;
  const pollMs = clock.pollMs ?? RUNTIME_RECEIPT_POLL_MS;
  const path = runtimeLaunchReceiptPath(launchId);
  for (;;) {
    // Read the receipt before the clock and before any process DTO: a valid
    // current-launch receipt is success or failure by itself, even past the
    // deadline or against a disagreeing terminal DTO.
    const read = await readRuntimeLaunchReceipt(reader, path, launchId);
    if (read.kind === 'receipt') return classifyReceipt(read.receipt);
    // No valid receipt: the clock owns the outcome at or past the deadline.
    if (now() >= deadlineAt) return { kind: 'deadline' };
    const terminal = await readTerminal(probe, processId);
    if (terminal.kind === 'terminal') {
      // A dead process with no valid receipt: spend one final read in case the
      // receipt landed in this window, then fail generically and promptly. The
      // DTO's exit number is never an artifact reason.
      const final = await readRuntimeLaunchReceipt(reader, path, launchId);
      if (final.kind === 'receipt') return classifyReceipt(final.receipt);
      return { kind: 'bootstrap-failed' };
    }
    const remaining = deadlineAt - now();
    if (remaining <= 0) return { kind: 'deadline' };
    await sleep(Math.min(pollMs, remaining));
  }
}

/** Normalized process observation: exact supervisor PID 1, alive, gone, or unknown. */
export type RuntimeLaunchProcessObservation = 'supervisor' | 'running' | 'terminal' | 'unknown';

/** One provider-neutral observation: the raw receipt (if any) and the process state. */
export type RuntimeLaunchObservation = {
  receipt?: string;
  process: RuntimeLaunchProcessObservation;
  /** The launch's token was retired or superseded; it owns nothing now. */
  retired?: true;
};

export type RuntimeLaunchObserver = (input: {
  providerRef: string;
  launchId: string;
  deadlineAt: number;
}) => Promise<RuntimeLaunchObservation>;

export type RuntimeLaunchReconciliation = {
  outcome: RuntimeLaunchOutcome;
  /** The exact valid current-launch receipt observed, when any. */
  receipt?: string;
};

function parseObservedReceipt(
  content: string | undefined,
  launchId: string
): RuntimeLaunchReceipt | undefined {
  if (content === undefined) return undefined;
  try {
    return parseRuntimeLaunchReceipt(content, launchId);
  } catch {
    return undefined;
  }
}

/**
 * Reconcile a possibly-issued start against normalized observations. A valid
 * current-launch failure receipt wins immediately; a handoff needs the handoff
 * receipt (for release) and the exact supervisor PID 1; malformed or foreign
 * receipts are never typed; the clock owns the deadline and a terminal process
 * with no valid receipt fails generically. Bounded by the same attempt deadline.
 */
export async function reconcileRuntimeLaunch(input: {
  observe: RuntimeLaunchObserver;
  providerRef: string;
  launchId: string;
  deadlineAt: number;
  requireHandoffReceipt: boolean;
  clock?: RuntimeLaunchPhaseClock;
}): Promise<RuntimeLaunchReconciliation> {
  const now = input.clock?.now ?? Date.now;
  const sleep = input.clock?.sleep ?? defaultSleep;
  const pollMs = input.clock?.pollMs ?? RUNTIME_RECEIPT_POLL_MS;
  for (;;) {
    const observation = await input.observe({
      providerRef: input.providerRef,
      launchId: input.launchId,
      deadlineAt: input.deadlineAt,
    });
    // A retired or superseded token owns nothing: stop immediately rather than
    // poll a stopped or replaced container to the bound.
    if (observation.retired === true) return { outcome: { kind: 'ownership-lost' } };
    const receipt = parseObservedReceipt(observation.receipt, input.launchId);
    if (receipt !== undefined) {
      if (receipt.outcome === 'installer_failed') {
        return { outcome: classifyReceipt(receipt), receipt: observation.receipt };
      }
      if (observation.process === 'supervisor') {
        return { outcome: { kind: 'handoff' }, receipt: observation.receipt };
      }
    } else if (!input.requireHandoffReceipt && observation.process === 'supervisor') {
      return { outcome: { kind: 'handoff' } };
    }
    if (now() >= input.deadlineAt) return { outcome: { kind: 'deadline' } };
    if (observation.process === 'terminal') return { outcome: { kind: 'bootstrap-failed' } };
    await sleep(Math.min(pollMs, input.deadlineAt - now()));
  }
}
