import { execFileSync, spawnSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withProcessLock } from './process-lock';

export type SimulatorDevice = {
  id: string;
  name: string;
  state: string;
  deviceTypeIdentifier?: string;
};
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
type ExecWithOutputFn = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => CommandResult;
// Rename hook used to set and restore the visible simulator name.
// Production wires this to `xcrun simctl rename <device> <name>`.
// Injectable for deterministic tests.
export type RenameFn = (deviceId: string, name: string) => void;
// Shutdown hook used to power the device off on release.
// Production wires this to `xcrun simctl shutdown <device>`.
// Injectable for deterministic tests.
export type ShutdownFn = (deviceId: string) => void;
// A claim is a small JSON lock file owned by a worktree. It is stale —
// and silently reclaimable — when its worktree no longer exists on
// disk. Concurrency is handled by atomic `wx` creation plus a short
// per-device mutation lock; device-phase parallelism is capped by the
// machine-global slot semaphore (external multi-agent tooling), so no
// heavier ownership protocol is needed here.
type ClaimRecord = {
  deviceId?: string;
  worktreeRoot?: string;
  claimedAt?: string;
  // The simulator's name at the moment of claim, restored on release,
  // and the visible label currently applied. Absent on claims written
  // before the label was applied (e.g. a claim whose process died
  // before renaming).
  originalDeviceName?: string;
  currentDeviceName?: string;
  // Whether this claim is what booted the device. Release powers the
  // device off only when this is true, so a simulator that was already
  // running before the claim is never shut down under someone else.
  // Absent on claims written before this field existed — treated as
  // false, which leaks a device at worst and never steals one.
  bootedByClaim?: boolean;
};
type ClaimArgs = {
  devices: SimulatorDevice[];
  lockRoot: string;
  worktreeRoot: string;
  requestedId?: string;
  // Rename hook applied on every fresh claim and on a same-worktree
  // reclaim whose stored label is stale. Defaults to
  // `xcrun simctl rename` in production via `main`. Tests inject a
  // recording stub.
  rename?: RenameFn;
  // Returns true when it actually booted the device, false when the
  // device was already running and was adopted as-is. That answer is
  // only knowable here, so it is recorded in the claim for release.
  prepare?: (device: SimulatorDevice) => boolean | void;
  // Shutdown hook used on claim rollback: when prepare booted the device
  // but a later step (the rename) failed, the abandoned claim's device is
  // powered back off. Without it a booted device would sit unclaimed.
  shutdown?: ShutdownFn;
  fileOperations?: {
    readFileSync?: (filePath: string, encoding: 'utf8') => string;
  };
};

// Build the deterministic visible label for a claimed simulator:
// `Kilo E2E - <sanitized-worktree-basename>`, bounded to 64 characters.
// The worktree basename is sanitized by collapsing runs of characters
// outside `[A-Za-z0-9._-]` to a single dash, trimming leading/trailing
// separators, and falling back to `worktree` when the result is empty.
// Pure helper exported for tests.
function buildSimulatorLabel(worktreeRoot: string): string {
  const prefix = 'Kilo E2E - ';
  const maxWorktreeSegment = 64 - prefix.length;
  const basename = path.basename(worktreeRoot);
  const sanitized =
    basename
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, Math.max(0, maxWorktreeSegment))
      .replace(/^-+|-+$/g, '') || 'worktree';
  return `${prefix}${sanitized}`;
}

// Parse the CLI arguments: `claim [<udid>]`, `release <udid>`, or
// `release-all`. Pure helper exported for tests.
function parseClaimArgs(
  argv: readonly string[]
):
  | { command: 'claim'; udid: string | undefined }
  | { command: 'release'; udid: string }
  | { command: 'release-all' } {
  const [command, ...rest] = argv;
  if (command === 'release-all') {
    if (rest.length !== 0) {
      throw new Error('Usage: release-all');
    }
    return { command: 'release-all' };
  }
  if (command === 'release') {
    if (rest.length !== 1) {
      throw new Error('Usage: release <udid>');
    }
    return { command: 'release', udid: rest[0] };
  }
  if (command !== 'claim' || rest.length > 1) {
    throw new Error('Usage: claim [<udid>] | release <udid> | release-all');
  }
  return { command: 'claim', udid: rest[0] };
}

function lockPath(lockRoot: string, deviceId: string): string {
  return path.join(lockRoot, `${deviceId}.json`);
}

// Write a claim record atomically. A plain writeFileSync truncates in place,
// so an unlocked reader (release-all, a peer's claim scan) can see a partial
// file, judge it corrupt, and delete a live claim. Temp file plus rename (or
// link for exclusive creation — it throws EEXIST exactly like flag "wx")
// makes every read see whole bytes, old or new.
function writeClaimAtomic(filePath: string, data: string, options?: { exclusive?: boolean }): void {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, data);
  try {
    if (options?.exclusive) fs.linkSync(tempPath, filePath);
    else fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

// Read the on-disk claim. Malformed files and claims whose worktree no
// longer exists are removed so a fresh claim can be written. Old-format
// records (from checkouts predating this protocol) still carry
// `worktreeRoot`, which is the only required field — their extra fields
// are ignored and ownership is enforced the same way.
function readClaim(
  lockRoot: string,
  deviceId: string,
  readFileSync: (filePath: string, encoding: 'utf8') => string = fs.readFileSync
): ClaimRecord | undefined {
  const filePath = lockPath(lockRoot, deviceId);
  const discard = (): undefined => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
    return undefined;
  };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    return discard();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return discard();
  }
  if (typeof parsed !== 'object' || parsed === null) return discard();
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.worktreeRoot !== 'string' || obj.worktreeRoot.length === 0) return discard();
  if (!fs.existsSync(obj.worktreeRoot)) return discard();
  return {
    deviceId: typeof obj.deviceId === 'string' ? obj.deviceId : undefined,
    worktreeRoot: obj.worktreeRoot,
    claimedAt: typeof obj.claimedAt === 'string' ? obj.claimedAt : undefined,
    originalDeviceName:
      typeof obj.originalDeviceName === 'string' ? obj.originalDeviceName : undefined,
    currentDeviceName:
      typeof obj.currentDeviceName === 'string' ? obj.currentDeviceName : undefined,
    bootedByClaim: obj.bootedByClaim === true,
  };
}

function withClaimMutationLock<T>(lockRoot: string, deviceId: string, mutate: () => T): T {
  const mutationLockPath = `${lockPath(lockRoot, deviceId)}.lock`;
  return withProcessLock(mutationLockPath, `Simulator ${deviceId} claim`, mutate);
}

// Run a command and return its captured stdout, stderr, and exit status. Throws
// when the command exits non-zero so the existing thrown-error handling path
// still surfaces non-zero failures. The caller is responsible for parsing the
// captured output for terminal-failure indicators that can appear with exit 0.
function execWithOutput(
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options?.timeoutMs });
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
// (it never started).
//
// Returns true when this call booted the device and false when it adopted an
// already-running one, so the claim can record who is responsible for shutting
// it down again.
function bootSimulator(
  device: SimulatorDevice,
  exec: ExecFn = execFileSync,
  runWithOutput: ExecWithOutputFn = execWithOutput
): boolean {
  if (device.state === 'Booted') return false;
  let booted = false;
  try {
    exec('xcrun', ['simctl', 'boot', device.id], { stdio: 'ignore' });
    booted = true;
    // Bounded: a wedged CoreSimulator otherwise blocks the claim forever.
    // 15 minutes clears even a heavily loaded host; the timeout kill lands
    // in the catch below, which shuts the device back down.
    const result = runWithOutput('xcrun', ['simctl', 'bootstatus', device.id, '-b'], {
      timeoutMs: 900_000,
    });
    if (isBootstatusTerminalFailure(result)) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      // Echo a bounded tail of the captured output so the user can see why the
      // boot was rejected without flooding logs.
      const bounded = combined.split('\n').slice(-20).join('\n');
      throw new Error(`Simulator ${device.id} bootstatus reported terminal failure:\n${bounded}`);
    }
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (booted) {
      try {
        exec('xcrun', ['simctl', 'shutdown', device.id], { stdio: 'ignore' });
      } catch {
        // The device may still be running. Flag it so the caller keeps
        // the claim in place and a peer worktree cannot adopt a device
        // this attempt left booted.
        (wrapped as Error & { deviceMayBeRunning?: boolean }).deviceMayBeRunning = true;
      }
    }
    throw wrapped;
  }
  return true;
}

function claimSimulator(args: ClaimArgs): { device: SimulatorDevice; alreadyOwned: boolean } {
  const { devices, lockRoot, worktreeRoot, requestedId } = args;
  fs.mkdirSync(lockRoot, { recursive: true });
  const candidates = requestedId
    ? devices.filter(device => device.id === requestedId)
    : devices
        .filter(
          device =>
            typeof device.deviceTypeIdentifier === 'string' &&
            device.deviceTypeIdentifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-')
        )
        .sort((a, b) => Number(a.state === 'Booted') - Number(b.state === 'Booted'));
  if (candidates.length === 0)
    throw new Error(`Simulator ${requestedId ?? ''} is not available`.trim());

  const targetLabel = buildSimulatorLabel(worktreeRoot);

  for (const device of candidates) {
    try {
      const reclaimed = withClaimMutationLock(lockRoot, device.id, () => {
        const existing = readClaim(
          lockRoot,
          device.id,
          args.fileOperations?.readFileSync ?? fs.readFileSync
        );
        if (existing) {
          if (existing.worktreeRoot !== worktreeRoot) {
            throw new Error(`Simulator ${device.id} is claimed by ${existing.worktreeRoot}`);
          }
          // Same-worktree reclaim is idempotent. Reapply the label when
          // the stored one is stale (or was never applied because the
          // claiming process died before renaming).
          if (existing.currentDeviceName !== targetLabel) {
            if (!args.rename) {
              throw new Error(`Simulator ${device.id} relabel requires a rename hook`);
            }
            args.rename(device.id, targetLabel);
            const next: ClaimRecord = {
              ...existing,
              deviceId: device.id,
              currentDeviceName: targetLabel,
              originalDeviceName: existing.originalDeviceName ?? device.name,
            };
            writeClaimAtomic(lockPath(lockRoot, device.id), JSON.stringify(next));
          }
          return true;
        }
        writeClaimAtomic(
          lockPath(lockRoot, device.id),
          JSON.stringify({
            deviceId: device.id,
            worktreeRoot,
            claimedAt: new Date().toISOString(),
            // Recorded before the rename so a claim that dies mid-boot can
            // still restore the device's real name on release.
            originalDeviceName: device.name,
            // Boot INTENT, recorded before the boot happens: prepare boots
            // exactly when the device is not already running. If anything
            // later loses the post-boot rewrite, release still powers off a
            // device this claim booted (shutting down an already-shutdown
            // device is a tolerated no-op).
            bootedByClaim: device.state !== 'Booted',
          }),
          { exclusive: true }
        );
        return false;
      });

      if (reclaimed) {
        if (device.state === 'Booted') {
          return { device: { ...device, name: targetLabel }, alreadyOwned: true };
        }
        // A previous claim died mid-boot: the record exists but the device
        // is down. Boot through the same prepare hook as a fresh claim and
        // record bootedByClaim so release powers off what this reclaim
        // started (prepare holds no mutation lock, matching the fresh path).
        const bootedByClaim = args.prepare?.(device) === true;
        withClaimMutationLock(lockRoot, device.id, () => {
          const current = readClaim(
            lockRoot,
            device.id,
            args.fileOperations?.readFileSync ?? fs.readFileSync
          );
          if (current) {
            writeClaimAtomic(
              lockPath(lockRoot, device.id),
              JSON.stringify({ ...current, bootedByClaim })
            );
          }
        });
        return { device: { ...device, name: targetLabel }, alreadyOwned: true };
      }

      // The mutation lock is released before prepare runs so a stalled
      // bootstatus call cannot block peer claim attempts. The on-disk
      // claim is the source of truth; peers observe it and reject. On
      // failure past this point the claim this attempt created is
      // removed so the device does not stay reserved by a dead run —
      // unless the device may still be running (a failed boot whose
      // follow-up shutdown also failed), in which case the claim stays
      // so a peer cannot adopt a booted device.
      let bootedByClaim = false;
      try {
        bootedByClaim = args.prepare?.(device) === true;
        if (!args.rename) {
          throw new Error(`Simulator ${device.id} claim requires a rename hook`);
        }
        args.rename(device.id, targetLabel);
      } catch (error) {
        let keepClaim =
          error instanceof Error &&
          (error as Error & { deviceMayBeRunning?: boolean }).deviceMayBeRunning === true;
        // The boot succeeded but the claim is being abandoned (the rename
        // failed): power the device back off, or keep the claim so a peer
        // cannot adopt a device this attempt left booted.
        if (!keepClaim && bootedByClaim && args.shutdown) {
          try {
            args.shutdown(device.id);
          } catch {
            keepClaim = true;
          }
        }
        if (!keepClaim) {
          withClaimMutationLock(lockRoot, device.id, () => {
            fs.rmSync(lockPath(lockRoot, device.id), { force: true });
          });
        }
        throw error;
      }
      withClaimMutationLock(lockRoot, device.id, () => {
        writeClaimAtomic(
          lockPath(lockRoot, device.id),
          JSON.stringify({
            deviceId: device.id,
            worktreeRoot,
            claimedAt: new Date().toISOString(),
            originalDeviceName: device.name,
            currentDeviceName: targetLabel,
            bootedByClaim,
          })
        );
      });
      return { device: { ...device, name: targetLabel }, alreadyOwned: false };
    } catch (error) {
      if (requestedId) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        continue; // claimed concurrently — try the next candidate
      }
      if (
        error instanceof Error &&
        (error.message.includes(' is claimed by ') ||
          error.message.includes(' claim is being updated concurrently'))
      ) {
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
  // Optional rename hook used to restore the original simulator name
  // before deleting an owned claim. Claims without `originalDeviceName`
  // (no label was applied) skip the restore.
  rename?: RenameFn;
  // Optional shutdown hook. Invoked only for a claim that recorded
  // `bootedByClaim`, so releasing a device that was already running
  // before the claim leaves it running.
  shutdown?: ShutdownFn;
}): void {
  withClaimMutationLock(args.lockRoot, args.deviceId, () => {
    const filePath = lockPath(args.lockRoot, args.deviceId);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return; // nothing to release — idempotent
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Do not delete unknown data; surface a clear error so an operator
      // can inspect the on-disk record manually.
      throw new Error(`Simulator ${args.deviceId} claim is corrupt and cannot be released`, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Simulator ${args.deviceId} claim is corrupt and cannot be released`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.worktreeRoot !== 'string' || record.worktreeRoot.length === 0) {
      throw new Error(`Simulator ${args.deviceId} claim is corrupt and cannot be released`);
    }
    if (record.worktreeRoot !== args.worktreeRoot) {
      throw new Error(`Simulator ${args.deviceId} is claimed by ${record.worktreeRoot}`);
    }
    // Restore the original simulator name before deleting the claim.
    // A restoration failure preserves the claim and surfaces the
    // error so a peer (or operator) can investigate.
    if (
      args.rename !== undefined &&
      typeof record.originalDeviceName === 'string' &&
      record.originalDeviceName.length > 0
    ) {
      args.rename(args.deviceId, record.originalDeviceName);
    }
    // Power the device off before dropping the claim, but only when this
    // claim is what booted it. A shutdown failure preserves the claim and
    // surfaces the error rather than leaving a running device unclaimed.
    if (args.shutdown !== undefined && record.bootedByClaim === true) {
      args.shutdown(args.deviceId);
    }
    fs.rmSync(filePath, { force: true });
  });
}

// Release every simulator this worktree still holds, powering off the ones
// its claims booted. Callers that only know the worktree — teardown paths like
// external stop-resource wrappers, which stop a resource without
// ever seeing a UDID — need this so a forgotten `release <udid>` cannot leak a
// device.
// Returns the released device ids. Foreign claims are ignored, never touched.
function releaseWorktreeSimulators(args: {
  lockRoot: string;
  worktreeRoot: string;
  rename?: RenameFn;
  shutdown?: ShutdownFn;
}): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(args.lockRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const released: string[] = [];
  const failures: Error[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const deviceId = entry.slice(0, -'.json'.length);
    // `readClaim` discards corrupt records and claims whose worktree is gone,
    // so an unreadable claim simply is not ours to release.
    if (readClaim(args.lockRoot, deviceId)?.worktreeRoot !== args.worktreeRoot) continue;
    // Every claim gets its attempt before anything is reported. One device
    // that will not power off must not strand the rest of the worktree's
    // devices, which is the leak this whole path exists to prevent.
    try {
      releaseSimulator({ ...args, deviceId });
      released.push(deviceId);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Released ${released.length === 0 ? 'no simulator' : released.join(' ')}; ${failures.length} failed: ${failures.map(failure => failure.message).join('; ')}`
    );
  }
  return released;
}

function listIosDevices(exec: ExecFn = execFileSync): SimulatorDevice[] {
  const parsed: unknown = JSON.parse(
    exec('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      encoding: 'utf8',
    }).toString()
  );
  if (typeof parsed !== 'object' || parsed === null) return [];
  const devicesByRuntime = (parsed as Record<string, unknown>).devices;
  if (typeof devicesByRuntime !== 'object' || devicesByRuntime === null) return [];

  return Object.entries(devicesByRuntime)
    .filter(([runtime]) => runtime.includes('.iOS-'))
    .flatMap(([, devices]) => (Array.isArray(devices) ? devices : []))
    .flatMap(device => {
      if (typeof device !== 'object' || device === null) return [];
      const record = device as Record<string, unknown>;
      if (
        typeof record.udid !== 'string' ||
        record.udid.length === 0 ||
        typeof record.name !== 'string' ||
        record.name.length === 0 ||
        typeof record.state !== 'string' ||
        record.state.length === 0
      ) {
        return [];
      }
      return [
        {
          id: record.udid,
          name: record.name,
          state: record.state,
          deviceTypeIdentifier:
            typeof record.deviceTypeIdentifier === 'string'
              ? record.deviceTypeIdentifier
              : undefined,
        },
      ];
    });
}

// Production rename: `xcrun simctl rename <device> <name>`. Throws on
// non-zero exit so callers can handle failures (e.g., restore the
// original name on a claim rollback).
function defaultRename(deviceId: string, name: string): void {
  execFileSync('xcrun', ['simctl', 'rename', deviceId, name], { stdio: 'ignore' });
}

// Production shutdown: `xcrun simctl shutdown <device>`. A device that is
// already off exits non-zero with "Unable to shutdown device in current state:
// Shutdown" — the desired end state, so that one case is not an error.
function defaultShutdown(deviceId: string): void {
  const result = spawnSync('xcrun', ['simctl', 'shutdown', deviceId], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/current state: Shutdown/.test(output)) return;
  throw new Error(output.trim() || `xcrun simctl shutdown ${deviceId} failed`);
}

function main(): void {
  const parsed = parseClaimArgs(process.argv.slice(2));
  const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const lockRoot = path.join(os.tmpdir(), 'kilo-mobile-simulator-claims');
  if (parsed.command === 'claim') {
    const claim = claimSimulator({
      devices: listIosDevices(),
      lockRoot,
      worktreeRoot,
      requestedId: parsed.udid,
      rename: defaultRename,
      prepare: device => bootSimulator(device),
      shutdown: defaultShutdown,
    });
    console.log(
      JSON.stringify({ ...claim, worktreeRoot, label: buildSimulatorLabel(worktreeRoot) })
    );
    return;
  }
  if (parsed.command === 'release-all') {
    const released = releaseWorktreeSimulators({
      lockRoot,
      worktreeRoot,
      rename: defaultRename,
      shutdown: defaultShutdown,
    });
    console.log(
      released.length === 0
        ? `No simulator claimed by ${worktreeRoot}`
        : `Released ${released.join(' ')}`
    );
    return;
  }
  // parsed.command === 'release'
  releaseSimulator({
    deviceId: parsed.udid,
    lockRoot,
    worktreeRoot,
    rename: defaultRename,
    shutdown: defaultShutdown,
  });
  console.log(`Released ${parsed.udid}`);
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

export {
  bootSimulator,
  buildSimulatorLabel,
  claimSimulator,
  listIosDevices,
  parseClaimArgs,
  releaseSimulator,
  releaseWorktreeSimulators,
};
