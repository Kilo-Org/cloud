import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withProcessLock } from './process-lock';

type SimulatorDevice = { id: string; name: string; state: string };
type ExecFn = (
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding
) => string | Buffer;
type CommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};
type ExecWithOutputFn = (command: string, args: readonly string[]) => CommandResult;
type ClaimArgs = {
  devices: SimulatorDevice[];
  lockRoot: string;
  worktreeRoot: string;
  requestedId?: string;
  prepare?: (device: SimulatorDevice) => void;
  fileOperations?: {
    readFileSync?: (filePath: string, encoding: 'utf8') => string;
  };
};

function lockPath(lockRoot: string, deviceId: string): string {
  return path.join(lockRoot, `${deviceId}.json`);
}

function readOwner(
  lockRoot: string,
  deviceId: string,
  readFileSync: (filePath: string, encoding: 'utf8') => string = fs.readFileSync
): string | undefined {
  try {
    const claim = JSON.parse(readFileSync(lockPath(lockRoot, deviceId), 'utf8')) as {
      worktreeRoot?: string;
    };
    if (claim.worktreeRoot && fs.existsSync(claim.worktreeRoot)) return claim.worktreeRoot;
    fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    // Invalid claims are unowned.
  }
  return undefined;
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
// (it never started).
function bootSimulator(
  device: SimulatorDevice,
  exec: ExecFn = execFileSync,
  runWithOutput: ExecWithOutputFn = execWithOutput
): void {
  if (device.state === 'Booted') return;
  let booted = false;
  try {
    exec('xcrun', ['simctl', 'boot', device.id], { stdio: 'ignore' });
    booted = true;
    const result = runWithOutput('xcrun', ['simctl', 'bootstatus', device.id, '-b']);
    if (isBootstatusTerminalFailure(result)) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      // Echo a bounded tail of the captured output so the user can see why the
      // boot was rejected without flooding logs.
      const bounded = combined.split('\n').slice(-20).join('\n');
      throw new Error(`Simulator ${device.id} bootstatus reported terminal failure:\n${bounded}`);
    }
  } catch (error) {
    if (booted) {
      try {
        exec('xcrun', ['simctl', 'shutdown', device.id], { stdio: 'ignore' });
      } catch {
        // Swallow shutdown failures so the original boot/bootstatus error
        // surfaces to the caller.
      }
    }
    throw error;
  }
}

function claimSimulator(args: ClaimArgs): { device: SimulatorDevice; alreadyOwned: boolean } {
  const { devices, lockRoot, worktreeRoot, requestedId } = args;
  fs.mkdirSync(lockRoot, { recursive: true });
  const candidates = requestedId
    ? devices.filter(device => device.id === requestedId)
    : [...devices].sort((a, b) => Number(a.state === 'Booted') - Number(b.state === 'Booted'));
  if (candidates.length === 0)
    throw new Error(`Simulator ${requestedId ?? ''} is not available`.trim());

  for (const device of candidates) {
    try {
      const claim = withClaimMutationLock(lockRoot, device.id, () => {
        const owner = readOwner(
          lockRoot,
          device.id,
          args.fileOperations?.readFileSync ?? fs.readFileSync
        );
        const alreadyOwned = owner === worktreeRoot;
        if (owner && !alreadyOwned) {
          throw new Error(`Simulator ${device.id} is claimed by ${owner}`);
        }
        if (!alreadyOwned) {
          fs.writeFileSync(
            lockPath(lockRoot, device.id),
            JSON.stringify({
              deviceId: device.id,
              worktreeRoot,
              claimedAt: new Date().toISOString(),
            }),
            { flag: 'wx' }
          );
        }
        // Hold the device mutation lock through preparation so a same-worktree
        // concurrent caller cannot adopt the claim we just created while
        // preparation is in flight. If the prepare callback throws, the
        // rollback below removes only the claim this exact call created; a
        // pre-existing same-worktree claim is preserved. We inline the
        // cleanup because releaseSimulator re-acquires this same lock.
        try {
          args.prepare?.(device);
        } catch (error) {
          if (!alreadyOwned) {
            fs.rmSync(lockPath(lockRoot, device.id), { force: true });
          }
          throw error;
        }
        return { device, alreadyOwned };
      });
      return claim;
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
    const owner = readOwner(args.lockRoot, args.deviceId);
    if (owner && owner !== args.worktreeRoot) {
      throw new Error(`Simulator ${args.deviceId} is claimed by ${owner}`);
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
export type { SimulatorDevice };
