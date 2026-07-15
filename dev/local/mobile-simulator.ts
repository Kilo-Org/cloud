import { execFileSync, spawnSync, type ExecFileSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withProcessLock } from './process-lock';

type SimulatorDevice = { id: string; name: string; state: string };
type ExecFn = (
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions
) => string | Buffer;
type CommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};
type ExecWithOutputFn = (command: string, args: readonly string[]) => CommandResult;
type ClaimStatus = 'preparing' | 'ready';
// All fields are optional in the exported type. Current-format claims
// require deviceId, worktreeRoot, claimId, status, and claimedAt;
// legacy claims (no `status`) require only worktreeRoot. The
// `isValidCurrentClaim` and `isValidLegacyClaim` helpers enforce the
// required fields without String coercion.
type ClaimRecord = {
  deviceId?: string;
  worktreeRoot?: string;
  claimId?: string;
  // Preparer process PID and start identity. Both are required for
  // current-format claims; legacy claims (no `status`) may omit them.
  // Identity is the normalized output of `ps -o lstart= -p <pid>` and
  // is used to detect PID reuse: a dead PID reassigned to a different
  // process will have a different identity.
  preparerPid?: number;
  preparerIdentity?: string;
  status?: ClaimStatus;
  claimedAt?: string;
};
type ClaimArgs = {
  devices: SimulatorDevice[];
  lockRoot: string;
  worktreeRoot: string;
  requestedId?: string;
  prepare?: (device: SimulatorDevice) => void;
  // Recovery reset contract: REQUIRED for abandoned-preparation
  // recovery. The callback receives a deviceId and must return a
  // confirmed Shutdown device. It is responsible for re-reading the
  // actual simulator state, issuing a shutdown if needed, and
  // confirming Shutdown before returning. If the callback is absent
  // during recovery, claimSimulator throws and preserves the new
  // preparing claim. No lock is held across the callback's commands.
  recoveryReset?: (deviceId: string) => SimulatorDevice;
  // Process identity probe: `ps -o lstart= -p <pid>` (darwin/linux).
  // Returns the normalized start time string, or undefined if it
  // cannot be queried. Injectable for deterministic tests.
  processIdentity?: (pid: number) => string | undefined;
  // PID liveness probe. `process.kill(pid, 0)` returns true for alive
  // PIDs and throws EPERM (alive but no permission) or ESRCH (dead).
  // Injectable for deterministic tests.
  pidAlive?: (pid: number) => boolean;
  fileOperations?: {
    readFileSync?: (filePath: string, encoding: 'utf8') => string;
    // Injectable rmSync used only for exact-own rollback deletion.
    // Default is `fs.rmSync`. Tests can inject a throwing stub to
    // verify cleanup-error attachment without platform-specific
    // filesystem tricks.
    rmSync?: (filePath: string, options: { force?: boolean }) => void;
  };
};

// Typed error thrown by `bootSimulator` so the caller can distinguish a
// prepare failure (safe to roll back the claim) from a prepare failure whose
// follow-up shutdown also failed (unsafe to roll back — the device may still
// be running and must remain reserved). The original cause is preserved on
// `error.cause`.
export class PrepareError extends Error {
  readonly shutdownFailed: boolean;
  constructor(message: string, options: { shutdownFailed: boolean; cause?: unknown }) {
    super(message);
    this.name = 'PrepareError';
    this.shutdownFailed = options.shutdownFailed;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function lockPath(lockRoot: string, deviceId: string): string {
  return path.join(lockRoot, `${deviceId}.json`);
}

// Probe a PID for liveness. `process.kill(pid, 0)` throws ESRCH when the
// process is dead and EPERM when it is alive but we cannot signal it; both
// are resolved here into a boolean. Process liveness — not wall-clock
// staleness — is the source of truth for abandoned-preparation recovery.
function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') return true;
      if (error.code === 'ESRCH') return false;
    }
    return false;
  }
}

// Query a process start identity. `ps -o lstart= -p <pid>` returns the
// human-readable start time (e.g. "Wed Jul 15 03:22:00 2026") on
// darwin and linux. The trimmed output is unique per process and
// survives PID reuse: a dead PID reassigned to a different process
// will produce a different identity. Returns undefined if the query
// fails or the process is gone.
function defaultProcessIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.error) return undefined;
    if (result.status !== 0) return undefined;
    const stdout = result.stdout ? result.stdout.toString() : '';
    const identity = stdout.replace(/\s+/g, ' ').trim();
    return identity || undefined;
  } catch {
    return undefined;
  }
}

// Validate that a parsed claim has the required fields for a
// current-format record, without String coercion. Returns true if the
// claim is well-formed. A claim whose `status` is absent is treated as
// legacy and is validated separately (only `worktreeRoot` is required).
function isValidCurrentClaim(obj: Record<string, unknown>): boolean {
  if (typeof obj.deviceId !== 'string' || obj.deviceId.length === 0) return false;
  if (typeof obj.worktreeRoot !== 'string' || obj.worktreeRoot.length === 0) return false;
  if (typeof obj.claimId !== 'string' || obj.claimId.length === 0) return false;
  if (typeof obj.status !== 'string') return false;
  if (obj.status !== 'preparing' && obj.status !== 'ready') return false;
  if (typeof obj.claimedAt !== 'string') return false;
  if (isNaN(Date.parse(obj.claimedAt))) return false;
  if (
    obj.preparerPid !== undefined &&
    (typeof obj.preparerPid !== 'number' ||
      !Number.isInteger(obj.preparerPid) ||
      obj.preparerPid <= 0)
  ) {
    return false;
  }
  if (obj.preparerIdentity !== undefined && typeof obj.preparerIdentity !== 'string') {
    return false;
  }
  return true;
}

function isValidLegacyClaim(obj: Record<string, unknown>): boolean {
  // Legacy claims have no `status` field and only require a worktreeRoot.
  return typeof obj.worktreeRoot === 'string' && obj.worktreeRoot.length > 0;
}

// Read the full on-disk claim, cleaning up invalid or stale entries. Used
// during the initial claim phase where stale-worktree cleanup is safe.
// Preparing claims are never deleted based on stale worktreeRoot — the
// caller uses PID liveness + identity to decide whether the preparation
// is active, abandoned, or legacy. Malformed claims (missing required
// fields, wrong types, unparseable dates) are removed in the initial
// phase so a fresh claim can be written.
function readClaim(
  lockRoot: string,
  deviceId: string,
  readFileSync: (filePath: string, encoding: 'utf8') => string = fs.readFileSync
): ClaimRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath(lockRoot, deviceId), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    try {
      fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    try {
      fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  // Legacy: no `status` field, only worktreeRoot.
  if (obj.status === undefined) {
    if (!isValidLegacyClaim(obj)) {
      try {
        fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
      } catch {
        // ignore
      }
      return undefined;
    }
    const worktreeRoot = obj.worktreeRoot as string;
    if (fs.existsSync(worktreeRoot)) return { worktreeRoot };
    try {
      fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  // Current-format claim: validate required fields strictly.
  if (!isValidCurrentClaim(obj)) {
    try {
      fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  const claim = obj as unknown as ClaimRecord;
  if (claim.status === 'preparing') return claim;
  // Ready: check worktreeRoot liveness.
  if (claim.worktreeRoot && fs.existsSync(claim.worktreeRoot)) return claim;
  try {
    fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
  } catch {
    // ignore
  }
  return undefined;
}

// Read the on-disk claim without stale-worktree cleanup. Used during the
// finalization phase where deleting a claim out from under the in-flight
// prepare would be unsafe. A legacy claim (missing status/claimId but a
// valid worktreeRoot) is treated as ready so older worktrees that predate
// the state protocol keep working. Status membership is validated
// exactly — any value other than 'preparing' or 'ready' is corrupt.
function readClaimRaw(
  lockRoot: string,
  deviceId: string
):
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'current'; record: ClaimRecord }
  | { kind: 'legacy'; worktreeRoot: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath(lockRoot, deviceId), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    // Unexpected I/O error: report as corrupt so the caller does not
    // silently delete the record.
    return { kind: 'corrupt' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'corrupt' };
  const obj = parsed as Record<string, unknown>;
  if (obj.status === undefined) {
    if (!isValidLegacyClaim(obj)) return { kind: 'corrupt' };
    return { kind: 'legacy', worktreeRoot: obj.worktreeRoot as string };
  }
  if (!isValidCurrentClaim(obj)) return { kind: 'corrupt' };
  return {
    kind: 'current',
    record: {
      deviceId: obj.deviceId as string,
      worktreeRoot: obj.worktreeRoot as string,
      claimId: obj.claimId as string,
      preparerPid: typeof obj.preparerPid === 'number' ? obj.preparerPid : undefined,
      preparerIdentity: typeof obj.preparerIdentity === 'string' ? obj.preparerIdentity : undefined,
      status: obj.status as ClaimStatus,
      claimedAt: obj.claimedAt as string,
    },
  };
}

// Classify a preparing claim as active or abandoned. A claim is active
// iff its preparer PID is alive AND its stored process identity matches
// the current process identity queried at decision time. PID reuse (a
// dead PID reassigned to a different process) is detected by the
// identity mismatch. If the identity cannot be queried (or is missing
// from the stored claim), the claim is treated as abandoned — fail
// closed. Arbitrary time-based staleness is not used.
function isClaimActive(
  claim: ClaimRecord,
  pidAlive: (pid: number) => boolean,
  processIdentity: (pid: number) => string | undefined
): boolean {
  if (typeof claim.preparerPid !== 'number' || claim.preparerPid <= 0) return false;
  if (!pidAlive(claim.preparerPid)) return false;
  // PID is alive — verify identity to detect PID reuse. Both the
  // stored and current identities must be queryable and match.
  if (claim.preparerIdentity === undefined) return false;
  const preparerIdentity = processIdentity(claim.preparerPid);
  if (preparerIdentity === undefined) return false;
  return claim.preparerIdentity === preparerIdentity;
}

function withClaimMutationLock<T>(lockRoot: string, deviceId: string, mutate: () => T): T {
  const mutationLockPath = `${lockPath(lockRoot, deviceId)}.lock`;
  return withProcessLock(mutationLockPath, `Simulator ${deviceId} claim`, mutate);
}

// Run a command and return its captured stdout, stderr, and exit status. Throws
// when the command exits non-zero so the existing thrown-error handling path
// still surfaces non-zero failures. The caller is responsible for parsing the
// captured output for terminal-failure indicators that can appear with exit 0.
function execWithOutput(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${command} ${args.join(' ')} terminated with ${result.signal}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : '';
    const message =
      stderr.trim() || `${command} ${args.join(' ')} exited with status ${result.status}`;
    const error = new Error(message);
    (error as Error & { status?: number | null }).status = result.status;
    (error as Error & { stdout?: string }).stdout = result.stdout?.toString() ?? '';
    (error as Error & { stderr?: string }).stderr = stderr;
    throw error;
  }
  return {
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
    status: result.status,
  };
}

// Detect a terminal bootstatus failure in captured output. `xcrun simctl
// bootstatus -b` can return exit 0 with `Status=3, isTerminal=YES` and a
// `Data Migration Failed` line on a corrupted simulator; treating that as
// success leaves a half-booted device in our claim. We match the specific
// status code 3 (shutdown) reported as terminal, or the explicit failure
// message — a terminal Status=0 (booted) is a success.
function isBootstatusTerminalFailure(result: CommandResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`;
  return /Status=3,?\s*isTerminal=YES/.test(combined) || /Data Migration Failed/.test(combined);
}

// Boot a shutdown simulator and wait for it to finish booting. If the boot
// succeeded but the subsequent `bootstatus` blocked boot failed (whether via
// non-zero exit or a terminal-failure output line), shut down the simulator
// that this attempt just booted so a follow-up claim does not observe a
// "Booted" device we started. Never shut down a simulator that was already
// booted by someone else, and never shut down a simulator whose `boot` failed
// (it never started). Throws a `PrepareError` whose `shutdownFailed` flag
// tells the caller whether the follow-up shutdown also failed — when it did,
// the device may still be running and the caller must preserve the claim so
// a peer worktree cannot adopt it.
function bootSimulator(
  device: SimulatorDevice,
  exec: ExecFn = execFileSync,
  runWithOutput: ExecWithOutputFn = execWithOutput
): void {
  if (device.state === 'Booted') return;
  let booted = false;
  let shutdownFailed = false;
  let cause: unknown;
  try {
    exec('xcrun', ['simctl', 'boot', device.id], { stdio: 'ignore' });
    booted = true;
    const result = runWithOutput('xcrun', ['simctl', 'bootstatus', device.id, '-b']);
    if (isBootstatusTerminalFailure(result)) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      // Echo a bounded tail of the captured output so the user can see why the
      // boot was rejected without flooding logs.
      const bounded = combined.split('\n').slice(-20).join('\n');
      cause = new Error(`Simulator ${device.id} bootstatus reported terminal failure:\n${bounded}`);
      throw cause;
    }
  } catch (error) {
    cause = error;
    if (booted) {
      try {
        exec('xcrun', ['simctl', 'shutdown', device.id], { stdio: 'ignore' });
      } catch {
        // The follow-up shutdown failed; the device may still be running.
        // Surface this via the typed `shutdownFailed` flag on PrepareError
        // so the caller preserves the preparing claim instead of removing it.
        shutdownFailed = true;
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new PrepareError(message, { shutdownFailed, cause });
  }
}

type ClaimOutcome =
  | { device: SimulatorDevice; alreadyOwned: true }
  | { device: SimulatorDevice; alreadyOwned: false; claimId: string; recovering: boolean };

function buildPreparingClaim(
  deviceId: string,
  worktreeRoot: string,
  claimId: string,
  processIdentity: (pid: number) => string | undefined
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    deviceId,
    worktreeRoot,
    claimId,
    preparerPid: process.pid,
    status: 'preparing',
    claimedAt: new Date().toISOString(),
  };
  const identity = processIdentity(process.pid);
  if (identity !== undefined) {
    record.preparerIdentity = identity;
  }
  return record;
}

function claimSimulator(args: ClaimArgs): { device: SimulatorDevice; alreadyOwned: boolean } {
  const { devices, lockRoot, worktreeRoot, requestedId } = args;
  fs.mkdirSync(lockRoot, { recursive: true });
  const candidates = requestedId
    ? devices.filter(device => device.id === requestedId)
    : [...devices].sort((a, b) => Number(a.state === 'Booted') - Number(b.state === 'Booted'));
  if (candidates.length === 0)
    throw new Error(`Simulator ${requestedId ?? ''} is not available`.trim());

  const pidAlive = args.pidAlive ?? defaultPidAlive;
  const processIdentity = args.processIdentity ?? defaultProcessIdentity;

  for (const device of candidates) {
    try {
      const outcome = withClaimMutationLock(lockRoot, device.id, (): ClaimOutcome => {
        const existing = readClaim(
          lockRoot,
          device.id,
          args.fileOperations?.readFileSync ?? fs.readFileSync
        );
        if (existing) {
          if (existing.status === 'preparing') {
            // A preparing claim is active iff its preparer PID is alive
            // AND its stored process identity matches the current
            // process identity queried at decision time. PID reuse (a
            // dead PID reassigned to a different process) is detected
            // by the identity mismatch. If the identity cannot be
            // queried or is missing, the claim is treated as abandoned
            // (fail closed). Recovery writes a fresh preparing claim
            // under the current process so a follow-up prepare can
            // safely reset the device state.
            const active = isClaimActive(existing, pidAlive, processIdentity);
            if (active) {
              if (existing.worktreeRoot === worktreeRoot) {
                throw new Error(`Simulator ${device.id} preparation in progress`);
              }
              throw new Error(`Simulator ${device.id} is claimed by ${existing.worktreeRoot}`);
            }
            // Abandoned preparing claim — adopt and replace.
            const claimId = randomUUID();
            fs.writeFileSync(
              lockPath(lockRoot, device.id),
              JSON.stringify(
                buildPreparingClaim(device.id, worktreeRoot, claimId, processIdentity)
              ),
              { flag: 'w' }
            );
            return { device, alreadyOwned: false, claimId, recovering: true };
          }
          if (existing.worktreeRoot === worktreeRoot) {
            return { device, alreadyOwned: true };
          }
          throw new Error(`Simulator ${device.id} is claimed by ${existing.worktreeRoot}`);
        }
        // No claim (or a stale one was cleaned up by readClaim). Create a
        // preparing claim with a unique claimId, the current PID, and the
        // current process identity so a later finalization or rollback
        // can verify it still owns the record.
        const claimId = randomUUID();
        fs.writeFileSync(
          lockPath(lockRoot, device.id),
          JSON.stringify(buildPreparingClaim(device.id, worktreeRoot, claimId, processIdentity)),
          { flag: 'wx' }
        );
        return { device, alreadyOwned: false, claimId, recovering: false };
      });

      if (outcome.alreadyOwned) {
        return { device: outcome.device, alreadyOwned: true };
      }

      // The mutation lock is released before recovery and prepare run so
      // a stalled bootstatus call cannot block peer claim attempts. The
      // on-disk `preparing` claim plus the unique `claimId` are the
      // source of truth; peer callers observe the preparing state and
      // reject.
      const claimId = outcome.claimId;

      // The device used for the normal prepare. For non-recovery claims
      // this is the list-time device. For recovery claims, the recovery
      // reset callback returns a confirmed Shutdown device — the
      // list-time snapshot is stale and must not be passed to
      // bootSimulator (which would skip the reboot and falsely finalize
      // ready).
      let prepareDevice: SimulatorDevice = device;

      if (outcome.recovering) {
        if (!args.recoveryReset) {
          // The recovery reset callback is required for abandoned
          // preparation recovery. Without it we cannot confirm the
          // device is in a Shutdown state, so we preserve the new
          // preparing claim and throw — a peer must not be able to
          // adopt a device that may still be running.
          throw new Error(
            `Simulator ${device.id} recovery reset is required to confirm the device is Shutdown before preparation can continue`
          );
        }
        let confirmedDevice: SimulatorDevice;
        try {
          confirmedDevice = args.recoveryReset(device.id);
        } catch (resetError) {
          // Preserve the new preparing claim (now owned by the current
          // process) and surface the recovery reset failure.
          throw new Error(
            `Simulator ${device.id} recovery reset failed: ${
              resetError instanceof Error ? resetError.message : String(resetError)
            }`,
            { cause: resetError }
          );
        }
        // Defensive: force the state to Shutdown so bootSimulator
        // cannot skip the reboot. The recovery reset is the source of
        // truth for the device state.
        prepareDevice = { ...confirmedDevice, state: 'Shutdown' as const };
      }

      let prepareError: PrepareError | undefined;
      try {
        args.prepare?.(prepareDevice);
      } catch (error) {
        prepareError =
          error instanceof PrepareError
            ? error
            : new PrepareError(error instanceof Error ? error.message : String(error), {
                shutdownFailed: false,
                cause: error,
              });
      }

      // Reacquire the mutation lock to finalize (mark ready) or roll back
      // (remove the preparing claim). The on-disk record is the source of
      // truth; we only touch it when our exact claimId is still current.
      // On any mismatch (missing, corrupt, or replaced) the finalization
      // path fails closed — it throws rather than silently returning
      // success — while the rollback path leaves the record alone (we
      // never delete data we do not own) and the original prepare error
      // still surfaces to the caller. If the exact-own rollback deletion
      // itself throws, the cleanup failure is attached to the prepare
      // error so the operator can see both the original cause and the
      // cleanup problem.
      withClaimMutationLock(lockRoot, device.id, () => {
        const result = readClaimRaw(lockRoot, device.id);
        const rmSync = args.fileOperations?.rmSync ?? fs.rmSync;
        if (prepareError) {
          if (prepareError.shutdownFailed) {
            // Preserve the preparing claim so a peer cannot adopt a
            // device that may still be running. The original prepare
            // error still surfaces to the caller via the throw below.
            return;
          }
          if (result.kind === 'current' && result.record.claimId === claimId) {
            try {
              rmSync(lockPath(lockRoot, device.id), { force: true });
            } catch (cleanupError) {
              // Attach the cleanup failure to the original prepare error
              // so the operator sees both; the original prepare failure
              // remains the primary reason the claim did not succeed.
              prepareError = new PrepareError(prepareError.message, {
                shutdownFailed: false,
                cause: prepareError.cause ?? prepareError,
              });
              (prepareError as PrepareError & { cleanupError?: unknown }).cleanupError =
                cleanupError;
            }
          }
          // For missing/corrupt/replaced records during rollback, do
          // nothing — the original prepare error will be thrown.
          return;
        }
        if (result.kind === 'missing') {
          throw new Error(
            `Simulator ${device.id} finalization failed: claim record vanished during prepare`
          );
        }
        if (result.kind === 'corrupt') {
          throw new Error(
            `Simulator ${device.id} finalization failed: claim record is corrupt and was not modified`
          );
        }
        if (result.kind === 'legacy') {
          // A legacy claim appeared mid-prepare (e.g., a peer on an
          // older worktree wrote it). We do not own it; fail closed.
          throw new Error(
            `Simulator ${device.id} finalization failed: claim record was replaced by a legacy entry`
          );
        }
        // result.kind === 'current'
        if (result.record.claimId !== claimId) {
          throw new Error(
            `Simulator ${device.id} finalization failed: claim record was replaced by another owner`
          );
        }
        fs.writeFileSync(
          lockPath(lockRoot, device.id),
          JSON.stringify({ ...result.record, status: 'ready' }),
          { flag: 'w' }
        );
      });

      if (prepareError) throw prepareError;
      return { device: outcome.device, alreadyOwned: false };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        if (requestedId) {
          throw new Error(`Simulator ${device.id} was claimed concurrently`, { cause: error });
        }
        continue;
      }
      if (
        error instanceof Error &&
        error.message.includes(' claim is being updated concurrently')
      ) {
        if (requestedId) throw error;
        continue;
      }
      if (error instanceof Error && error.message.includes(' is claimed by ')) {
        if (requestedId) throw error;
        continue;
      }
      if (error instanceof Error && error.message.includes('preparation in progress')) {
        if (requestedId) throw error;
        continue;
      }
      throw error;
    }
  }
  throw new Error('No unclaimed iOS simulator is available');
}

function releaseSimulator(args: {
  deviceId: string;
  lockRoot: string;
  worktreeRoot: string;
}): void {
  withClaimMutationLock(args.lockRoot, args.deviceId, () => {
    const result = readClaimRaw(args.lockRoot, args.deviceId);
    if (result.kind === 'missing') {
      // Nothing to release — idempotent.
      return;
    }
    if (result.kind === 'corrupt') {
      // Do not delete unknown data; surface a clear error so an operator
      // can inspect the on-disk record manually.
      throw new Error(`Simulator ${args.deviceId} claim is corrupt and cannot be released`);
    }
    if (result.kind === 'current') {
      if (result.record.status === 'preparing') {
        // A preparing claim may be mid-boot; releasing it would let a
        // peer adopt a device that is still being prepared.
        throw new Error(
          `Simulator ${args.deviceId} cannot be released while preparation is in progress`
        );
      }
      if (result.record.worktreeRoot !== args.worktreeRoot) {
        throw new Error(`Simulator ${args.deviceId} is claimed by ${result.record.worktreeRoot}`);
      }
    } else if (result.worktreeRoot !== args.worktreeRoot) {
      // Legacy claim — treat as ready, but enforce worktree ownership.
      throw new Error(`Simulator ${args.deviceId} is claimed by ${result.worktreeRoot}`);
    }
    fs.rmSync(lockPath(args.lockRoot, args.deviceId), { force: true });
  });
}

function listIosDevices(): SimulatorDevice[] {
  const raw = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      encoding: 'utf8',
    })
  ) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
  return Object.entries(raw.devices)
    .filter(([runtime]) => runtime.includes('.iOS-'))
    .flatMap(([, devices]) => devices)
    .map(device => ({ id: device.udid, name: device.name, state: device.state }));
}

function main(): void {
  const [command, requestedId] = process.argv.slice(2);
  const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const lockRoot = path.join(os.tmpdir(), 'kilo-mobile-simulator-claims');
  if (command === 'claim') {
    const claim = claimSimulator({
      devices: listIosDevices(),
      lockRoot,
      worktreeRoot,
      requestedId,
      prepare: device => bootSimulator(device),
      // Production recovery reset: re-read the actual simulator state
      // at decision time (not the list-time snapshot). If the device
      // is not Shutdown, issue a shutdown, re-read, and confirm
      // Shutdown. Throw if the shutdown cannot be confirmed so the
      // preparing claim is preserved and a peer cannot adopt a
      // possibly running device. No mutation lock is held across
      // these synchronous commands.
      recoveryReset: deviceId => {
        const reReadState = (): string | undefined => {
          const devices = listIosDevices();
          return devices.find(d => d.id === deviceId)?.state;
        };
        let state = reReadState();
        if (state === undefined) {
          throw new Error(`Simulator ${deviceId} not found during recovery reset`);
        }
        if (state !== 'Shutdown') {
          execFileSync('xcrun', ['simctl', 'shutdown', deviceId], { stdio: 'ignore' });
          state = reReadState();
          if (state !== 'Shutdown') {
            throw new Error(
              `Simulator ${deviceId} shutdown not confirmed (state=${state ?? 'unknown'})`
            );
          }
        }
        return { id: deviceId, name: deviceId, state: 'Shutdown' as const };
      },
    });
    console.log(JSON.stringify({ ...claim, worktreeRoot }));
    return;
  }
  if (command === 'release' && requestedId) {
    releaseSimulator({ deviceId: requestedId, lockRoot, worktreeRoot });
    console.log(`Released ${requestedId}`);
    return;
  }
  throw new Error('Usage: pnpm dev:mobile:simulator <claim [udid]|release <udid>>');
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export { bootSimulator, claimSimulator, releaseSimulator };
export type { SimulatorDevice, ClaimRecord, ClaimStatus };
