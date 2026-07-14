import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SimulatorDevice = { id: string; name: string; state: string };
type ClaimArgs = {
  devices: SimulatorDevice[];
  lockRoot: string;
  worktreeRoot: string;
  requestedId?: string;
};

function lockPath(lockRoot: string, deviceId: string): string {
  return path.join(lockRoot, `${deviceId}.json`);
}

function readOwner(lockRoot: string, deviceId: string): string | undefined {
  try {
    const claim = JSON.parse(fs.readFileSync(lockPath(lockRoot, deviceId), 'utf8')) as {
      worktreeRoot?: string;
    };
    if (claim.worktreeRoot && fs.existsSync(claim.worktreeRoot)) return claim.worktreeRoot;
    fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
  } catch {
    fs.rmSync(lockPath(lockRoot, deviceId), { force: true });
    // Missing or invalid claims are unowned.
  }
  return undefined;
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
    const owner = readOwner(lockRoot, device.id);
    if (owner === worktreeRoot) return { device, alreadyOwned: true };
    if (owner) {
      if (requestedId) throw new Error(`Simulator ${device.id} is claimed by ${owner}`);
      continue;
    }
    try {
      fs.writeFileSync(
        lockPath(lockRoot, device.id),
        JSON.stringify({ deviceId: device.id, worktreeRoot, claimedAt: new Date().toISOString() }),
        { flag: 'wx' }
      );
      return { device, alreadyOwned: false };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        if (requestedId) throw new Error(`Simulator ${device.id} was claimed concurrently`);
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
  const owner = readOwner(args.lockRoot, args.deviceId);
  if (owner && owner !== args.worktreeRoot) {
    throw new Error(`Simulator ${args.deviceId} is claimed by ${owner}`);
  }
  fs.rmSync(lockPath(args.lockRoot, args.deviceId), { force: true });
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
    });
    if (claim.device.state !== 'Booted') {
      execFileSync('xcrun', ['simctl', 'boot', claim.device.id], { stdio: 'ignore' });
      execFileSync('xcrun', ['simctl', 'bootstatus', claim.device.id, '-b'], { stdio: 'inherit' });
    }
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

export { claimSimulator, releaseSimulator };
export type { SimulatorDevice };
