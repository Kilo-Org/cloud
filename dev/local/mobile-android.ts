import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectHashAsync } from '@expo/fingerprint';

import {
  buildAndroidCompatibilityKey,
  buildAndroidFingerprintOptions,
  buildAndroidInstallCommand,
  pruneAndroidCache,
  runAndroidBuild,
} from './mobile-android-build';
import { withNativeBuildSemaphore } from './mobile-native-build';
import { fetchAndroidApk } from './mobile-remote-native';
import { withProcessLock, withProcessLockAsync } from './process-lock';

type AndroidEnvironment = {
  adb: string;
  emulator: string;
  javaHome: string;
  path: string;
  sdkRoot: string;
  sdkmanager?: string;
};

type ResolveArgs = {
  home: string;
  path: string;
  existingPaths?: ReadonlySet<string>;
  javaMajor?: (javaHome: string) => number | undefined;
};

type DeviceClaim = {
  serial: string;
  worktreeRoot: string;
  claimedAt: string;
  claimId: string;
  status: 'ready';
  // Linux boot id of the emulator instance the claim was taken against. ADB
  // serials are recycled ports, not device identities: the next emulator to
  // boot takes emulator-5554 again, so the serial alone cannot tell a live
  // claim from one left behind by a long-dead instance.
  bootId: string;
};
type ClaimOptions = {
  fileOperations?: {
    readFileSync?: (filePath: string, encoding: 'utf8') => string;
  };
};

type EmulatorRecord = {
  avd: string;
  gpu: string;
  log: string;
  pid: number;
  pidFile: string;
  port: number;
  serial: string;
  session: string;
  worktreeRoot: string;
};

function firstExisting(
  candidates: string[],
  exists: (candidate: string) => boolean
): string | undefined {
  return candidates.find(exists);
}

function resolveAndroidEnvironment(args: ResolveArgs): AndroidEnvironment {
  const existingPaths = args.existingPaths;
  const exists = existingPaths
    ? (candidate: string) => existingPaths.has(candidate)
    : fs.existsSync;
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(args.home, 'Library/Android/sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
  ].filter((value): value is string => Boolean(value));
  const sdkRoot = sdkRoots.find(
    root =>
      exists(path.join(root, 'platform-tools/adb')) && exists(path.join(root, 'emulator/emulator'))
  );
  if (!sdkRoot) {
    throw new Error(
      'Android SDK not found in ANDROID_HOME, ~/Library/Android/sdk, or Homebrew android-commandlinetools. Run: brew install --cask android-commandlinetools'
    );
  }

  const adb = path.join(sdkRoot, 'platform-tools/adb');
  const emulator = path.join(sdkRoot, 'emulator/emulator');
  const sdkmanager = firstExisting(
    [
      path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager'),
      '/opt/homebrew/bin/sdkmanager',
      '/usr/local/bin/sdkmanager',
    ],
    exists
  );
  const javaHomes = [
    '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home',
    '/opt/homebrew/opt/temurin@17/libexec/openjdk.jdk/Contents/Home',
    process.env.JAVA_HOME,
  ].filter((value): value is string => Boolean(value));
  const javaMajor =
    args.javaMajor ??
    ((candidate: string) => {
      const result = spawnSync(path.join(candidate, 'bin/java'), ['-version'], {
        encoding: 'utf8',
      });
      const match = `${result.stdout}${result.stderr}`.match(/version "(\d+)/);
      return match ? Number(match[1]) : undefined;
    });
  const javaHome = javaHomes.find(
    candidate => exists(path.join(candidate, 'bin/java')) && javaMajor(candidate) === 17
  );

  if (!javaHome) throw new Error('Android tooling incomplete: missing JDK 17');

  const toolPaths = [
    path.join(sdkRoot, 'platform-tools'),
    path.join(sdkRoot, 'emulator'),
    sdkmanager && path.dirname(sdkmanager),
    path.join(javaHome, 'bin'),
  ].filter((value): value is string => Boolean(value));
  return {
    adb,
    emulator,
    javaHome,
    path: [...toolPaths, args.path].join(path.delimiter),
    sdkRoot,
    sdkmanager,
  };
}

function environment(): AndroidEnvironment {
  return resolveAndroidEnvironment({ home: os.homedir(), path: process.env.PATH ?? '' });
}

function run(command: string, args: string[], env: AndroidEnvironment, cwd?: string): void {
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd,
    env: {
      ...process.env,
      ANDROID_HOME: env.sdkRoot,
      ANDROID_SDK_ROOT: env.sdkRoot,
      JAVA_HOME: env.javaHome,
      PATH: env.path,
    },
  });
}

function tmuxSessionExists(session: string): boolean {
  // `=` forces an exact session-name match; a bare -t prefix-matches, so a
  // sibling worktree whose slug extends ours would answer for our session.
  return spawnSync('tmux', ['has-session', '-t', `=${session}`]).status === 0;
}

function androidEmulatorSlug(worktreeRoot: string): string {
  return path.basename(worktreeRoot).replace(/[^A-Za-z0-9_-]/g, '_');
}

function androidEmulatorSession(worktreeRoot: string): string {
  return `kilo-e2e-android-${androidEmulatorSlug(worktreeRoot)}`;
}

function emulatorRecordPath(worktreeRoot: string): string {
  return path.join(
    os.tmpdir(),
    'kilo-mobile-android-emulators',
    `${androidEmulatorSlug(worktreeRoot)}.json`
  );
}

function portIsListening(port: number): boolean {
  return (
    spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }).status === 0
  );
}

function listeningProcessIds(port: number): number[] {
  const result = spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0);
}

function processOwnsListeningPort(
  port: number,
  pid: number,
  listeners: (port: number) => number[] = listeningProcessIds
): boolean {
  return listeners(port).includes(pid);
}

function findAvailableEmulatorPort(isListening = portIsListening): number | undefined {
  for (let port = 5554; port <= 5680; port += 2) {
    if (!isListening(port)) return port;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessIfPresent(
  pid: number,
  signal: NodeJS.Signals,
  sendSignal: typeof process.kill = process.kill
): void {
  try {
    sendSignal(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function commandMatchesRecordedEmulator(
  command: string,
  emulator: string,
  avd: string,
  port: number
): boolean {
  const qemuRoot = `${path.dirname(emulator)}${path.sep}qemu${path.sep}`;
  const exactArgument = (flag: string, value: string): boolean => {
    const escape = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escape(flag)}\\s+${escape(value)}(?=\\s|$)`).test(command);
  };
  return (
    (command.includes(emulator) || command.includes(qemuRoot)) &&
    exactArgument('-avd', avd) &&
    exactArgument('-port', String(port))
  );
}

function readProcessCommand(pid: number): string {
  return (
    spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).stdout?.trim() ?? ''
  );
}

type EmulatorProcessDeps = {
  processCommand: (pid: number) => string;
  processIsAlive: (pid: number) => boolean;
};

function recordedEmulatorStillOwnsPid(
  record: EmulatorRecord,
  env: AndroidEnvironment,
  deps?: Partial<EmulatorProcessDeps>
): boolean {
  const isAlive = deps?.processIsAlive ?? processIsAlive;
  const processCommand = deps?.processCommand ?? readProcessCommand;
  if (!isAlive(record.pid)) return false;
  const command = processCommand(record.pid);
  return commandMatchesRecordedEmulator(command, env.emulator, record.avd, record.port);
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// A cold boot on the Linux VM binds its console port after 45-48 s, and a
// loaded host stretches that further, so the default budget must cover a
// cold boot with headroom. Set KILO_EMULATOR_CONSOLE_PORT_WAIT_MS (in
// milliseconds) to override it for one launch.
const DEFAULT_CONSOLE_PORT_WAIT_MS = 120_000;
const DEFAULT_PID_WAIT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(2);
}

function requirePositiveMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
}

function consolePortWaitMs(override?: number): number {
  if (override !== undefined) return requirePositiveMs(override, 'portWaitMs');
  const raw = process.env.KILO_EMULATOR_CONSOLE_PORT_WAIT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CONSOLE_PORT_WAIT_MS;
  return requirePositiveMs(Number(raw), 'KILO_EMULATOR_CONSOLE_PORT_WAIT_MS');
}

function isValidEmulatorRecord(record: unknown, worktreeRoot: string): record is EmulatorRecord {
  if (typeof record !== 'object' || record === null) return false;
  const value = record as Partial<EmulatorRecord>;
  const expectedSession = androidEmulatorSession(worktreeRoot);
  return (
    value.worktreeRoot === worktreeRoot &&
    value.session === expectedSession &&
    value.pidFile === path.join(os.tmpdir(), `${expectedSession}.pid`) &&
    value.serial === `emulator-${value.port}` &&
    Number.isInteger(value.pid) &&
    Number.isInteger(value.port) &&
    (value.port ?? 0) >= 5554 &&
    (value.port ?? 0) <= 5680 &&
    (value.port ?? 0) % 2 === 0
  );
}

async function stopAndroidEmulator(env: AndroidEnvironment, worktreeRoot: string): Promise<void> {
  const recordPath = emulatorRecordPath(worktreeRoot);
  const expectedSession = androidEmulatorSession(worktreeRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (tmuxSessionExists(expectedSession))
      spawnSync('tmux', ['kill-session', '-t', `=${expectedSession}`], { stdio: 'ignore' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid emulator record at ${recordPath}; refusing teardown`);
  }
  if (!isValidEmulatorRecord(parsed, worktreeRoot))
    throw new Error(`Invalid emulator record at ${recordPath}; refusing teardown`);
  const record = parsed;

  if (tmuxSessionExists(record.session))
    spawnSync('tmux', ['kill-session', '-t', `=${record.session}`], { stdio: 'ignore' });
  for (let i = 0; i < 50 && processIsAlive(record.pid); i++) await delay(100);
  if (recordedEmulatorStillOwnsPid(record, env)) {
    signalProcessIfPresent(record.pid, 'SIGTERM');
    for (let i = 0; i < 50 && processIsAlive(record.pid); i++) await delay(100);
  }
  if (recordedEmulatorStillOwnsPid(record, env)) {
    signalProcessIfPresent(record.pid, 'SIGKILL');
    for (let i = 0; i < 20 && processIsAlive(record.pid); i++) await delay(100);
  }
  if (recordedEmulatorStillOwnsPid(record, env))
    throw new Error(`Emulator PID ${record.pid} did not stop; keeping ${recordPath}`);
  fs.rmSync(record.pidFile, { force: true });
  fs.rmSync(recordPath, { force: true });
}

type StartAndroidEmulatorOptions = {
  // Milliseconds to wait for the console port to bind. Defaults to
  // KILO_EMULATOR_CONSOLE_PORT_WAIT_MS, then DEFAULT_CONSOLE_PORT_WAIT_MS.
  portWaitMs?: number;
  // Milliseconds to wait for the tmux shell to record the emulator PID.
  pidWaitMs?: number;
  pollIntervalMs?: number;
  // Receives progress lines while the console-port wait runs, so a long cold
  // boot does not read as a hang. Defaults to stderr.
  report?: (message: string) => void;
  // Test seams. Defaults run tmux, lsof, ps, and signals on this host.
  launchSession?: (session: string, command: string, pidFile: string) => void;
  sessionExists?: (session: string) => boolean;
  killSession?: (session: string) => void;
  portIsListening?: (port: number) => boolean;
  listeningProcessIds?: (port: number) => number[];
  processIsAlive?: (pid: number) => boolean;
  processCommand?: (pid: number) => string;
  signal?: typeof process.kill;
  sleep?: (ms: number) => Promise<void>;
};

async function startAndroidEmulator(
  env: AndroidEnvironment,
  worktreeRoot: string,
  avd: string,
  gpu: string,
  options: StartAndroidEmulatorOptions = {}
): Promise<EmulatorRecord> {
  const session = androidEmulatorSession(worktreeRoot);
  const sessionExists = options.sessionExists ?? tmuxSessionExists;
  const killSession = (sessionName: string): void => {
    if (options.killSession) options.killSession(sessionName);
    else spawnSync('tmux', ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
  };
  const isPortListening = options.portIsListening ?? portIsListening;
  const listeningPids = options.listeningProcessIds ?? listeningProcessIds;
  const isProcessAlive = options.processIsAlive ?? processIsAlive;
  const processCommand = options.processCommand ?? readProcessCommand;
  const sleep = options.sleep ?? delay;
  const report = options.report ?? ((message: string) => console.error(message));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  requirePositiveMs(pollIntervalMs, 'pollIntervalMs');
  const pidWaitMs = options.pidWaitMs ?? DEFAULT_PID_WAIT_MS;
  const portWaitMs = consolePortWaitMs(options.portWaitMs);
  const pollLimit = (budgetMs: number): number => Math.max(1, Math.ceil(budgetMs / pollIntervalMs));

  return withProcessLockAsync(
    path.join(os.tmpdir(), 'kilo-mobile-android-emulators', 'launch.lock'),
    'Android emulator launch',
    async () => {
      const recordPath = emulatorRecordPath(worktreeRoot);
      if (sessionExists(session) || fs.existsSync(recordPath))
        throw new Error(
          `${session} already exists; run pnpm dev:mobile:android emulator-stop before launching another`
        );
      const port = findAvailableEmulatorPort(isPortListening);
      if (port === undefined) throw new Error('No free Android emulator console port (5554-5680)');
      const serial = `emulator-${port}`;
      const log = path.join(os.tmpdir(), `${session}.log`);
      const pidFile = path.join(os.tmpdir(), `${session}.pid`);
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.rmSync(log, { force: true });
      fs.rmSync(pidFile, { force: true });
      const emulatorArgs = [
        '-avd',
        avd,
        '-port',
        String(port),
        '-no-snapshot-save',
        '-no-boot-anim',
        '-gpu',
        gpu,
      ];
      const command = `echo $$ > ${shellQuote(pidFile)}; exec ${[env.emulator, ...emulatorArgs]
        .map(shellQuote)
        .join(' ')} >> ${shellQuote(log)} 2>&1`;
      const launchSession = (sessionName: string, launchCommand: string): void => {
        if (options.launchSession) options.launchSession(sessionName, launchCommand, pidFile);
        else
          execFileSync('tmux', [
            'new-session',
            '-d',
            '-s',
            sessionName,
            '-c',
            worktreeRoot,
            launchCommand,
          ]);
      };

      let pid = 0;
      let sessionStarted = false;
      try {
        launchSession(session, command);
        sessionStarted = true;
        for (let i = 0; i < pollLimit(pidWaitMs) && !fs.existsSync(pidFile); i++)
          await sleep(pollIntervalMs);
        try {
          pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          throw new Error(`${session} did not record its PID within ${formatSeconds(pidWaitMs)}s`);
        }
        if (!Number.isInteger(pid) || pid <= 0)
          throw new Error(`${session} did not record its PID within ${formatSeconds(pidWaitMs)}s`);
        const portPollLimit = pollLimit(portWaitMs);
        const progressEvery = Math.max(1, Math.ceil(portPollLimit / 4));
        for (let i = 0; i < portPollLimit && !isPortListening(port); i++) {
          if (!isProcessAlive(pid)) throw new Error(`${session} exited during launch; see ${log}`);
          if (i > 0 && i % progressEvery === 0)
            report(
              `Waiting for ${session} console port ${port}: ${Math.floor((i * pollIntervalMs) / 1000)}s of ${formatSeconds(portWaitMs)}s elapsed`
            );
          await sleep(pollIntervalMs);
        }
        if (!isPortListening(port))
          throw new Error(
            `${session} did not bind console port ${port} within ${formatSeconds(portWaitMs)}s; see ${log}`
          );
        if (!isProcessAlive(pid) || !processOwnsListeningPort(port, pid, listeningPids))
          throw new Error(
            `${session} does not own console port ${port}; refusing to record a foreign emulator`
          );
        const record = {
          avd,
          gpu,
          log,
          pid,
          pidFile,
          port,
          serial,
          session,
          worktreeRoot,
        } satisfies EmulatorRecord;
        const tempRecord = `${recordPath}.${process.pid}.tmp`;
        fs.writeFileSync(tempRecord, JSON.stringify(record, null, 2));
        fs.renameSync(tempRecord, recordPath);
        return record;
      } catch (error) {
        // A launch that fails for any reason must not leave the emulator it
        // started behind: no session, no orphan qemu, no record file.
        if (sessionStarted && sessionExists(session)) killSession(session);
        if (pid > 0) {
          const partialRecord = {
            avd,
            gpu,
            log,
            pid,
            pidFile,
            port,
            serial,
            session,
            worktreeRoot,
          };
          const stillOurs = () =>
            recordedEmulatorStillOwnsPid(partialRecord, env, {
              processCommand,
              processIsAlive: isProcessAlive,
            });
          if (stillOurs()) {
            signalProcessIfPresent(pid, 'SIGTERM', options.signal);
            for (let i = 0; i < pollLimit(5_000) && isProcessAlive(pid); i++)
              await sleep(pollIntervalMs);
          }
          if (stillOurs()) signalProcessIfPresent(pid, 'SIGKILL', options.signal);
        }
        fs.rmSync(pidFile, { force: true });
        fs.rmSync(`${recordPath}.${process.pid}.tmp`, { force: true });
        fs.rmSync(recordPath, { force: true });
        throw error;
      }
    },
    // Two slow holders (pid-file wait + full console-port budget + teardown
    // each) must not starve a third slot's healthy launch.
    300_000
  );
}

function getAndroidSerials(env: AndroidEnvironment): string[] {
  const output = execFileSync(env.adb, ['devices'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: env.path },
  });
  return output
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial);
}

function parseEmulatorStartArgs(args: string[]): { avd: string; gpu: string; wait: boolean } {
  const avd = args[0];
  const gpuIndex = args.indexOf('--gpu');
  const gpu = gpuIndex === -1 ? 'host' : args[gpuIndex + 1];
  const wait = args.includes('--wait');
  const expectedArgs = (gpuIndex === -1 ? 1 : 3) + (wait ? 1 : 0);
  if (
    !avd ||
    avd.startsWith('-') ||
    !gpu ||
    !['host', 'swiftshader_indirect'].includes(gpu) ||
    args.length !== expectedArgs
  ) {
    throw new Error(
      'Usage: pnpm dev:mobile:android emulator-start <avd-name> [--gpu host|swiftshader_indirect] [--wait]'
    );
  }
  return { avd, gpu, wait };
}

// Poll until the emulator is fully booted: process alive, serial visible as
// `device`, and sys.boot_completed=1. Console-port bind alone does not mean
// the guest is ready for installs or taps.
async function waitForAndroidBoot(env: AndroidEnvironment, record: EmulatorRecord): Promise<void> {
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    if (!processIsAlive(record.pid))
      throw new Error(`${record.session} died while booting; see ${record.log}`);
    try {
      const ready =
        getAndroidSerials(env).includes(record.serial) &&
        execFileSync(env.adb, ['-s', record.serial, 'shell', 'getprop', 'sys.boot_completed'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: env.path },
        }).trim() === '1';
      if (ready) return;
    } catch (error) {
      // adb errors mid-boot are transient; a dead emulator is not.
      if (error instanceof Error && !processIsAlive(record.pid))
        throw new Error(`${record.session} died while booting; see ${record.log}`);
    }
    if (Date.now() > deadline)
      throw new Error(
        `${record.serial} did not reach sys.boot_completed=1 within 8 minutes; see ${record.log}`
      );
    await delay(15_000);
  }
}

// Identity of the running emulator instance, stable for its whole life and
// regenerated by the guest kernel on every boot.
function readBootId(env: AndroidEnvironment, serial: string): string {
  const bootId = execFileSync(
    env.adb,
    ['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id'],
    { encoding: 'utf8', env: androidProcessEnv(env) }
  ).trim();
  if (!bootId) throw new Error(`Unable to read the boot id of ${serial}`);
  return bootId;
}

function claimPath(serial: string): string {
  return path.join(
    os.tmpdir(),
    'kilo-mobile-android-claims',
    `${serial.replaceAll('/', '_')}.json`
  );
}

function withClaimMutationLock<T>(filePath: string, mutate: () => T): T {
  const lockFilePath = `${filePath}.lock`;
  return withProcessLock(lockFilePath, `${path.basename(filePath, '.json')} claim`, mutate);
}

function claimAndroidDevice(
  serial: string,
  worktreeRoot: string,
  bootId: string,
  options?: ClaimOptions
): DeviceClaim {
  const filePath = claimPath(serial);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return withClaimMutationLock(filePath, () => {
    try {
      const readFileSync = options?.fileOperations?.readFileSync ?? fs.readFileSync;
      const claim = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DeviceClaim>;
      if (claim.worktreeRoot === worktreeRoot) {
        if (
          claim.status === 'ready' &&
          typeof claim.claimId === 'string' &&
          claim.bootId === bootId
        )
          return claim as DeviceClaim;
        const upgraded = buildReadyClaim(serial, worktreeRoot, bootId);
        fs.writeFileSync(filePath, JSON.stringify(upgraded));
        return upgraded;
      }
      // A foreign claim only holds this serial while it names the emulator
      // instance currently answering on it. Claims from earlier instances, and
      // claims written before boot ids were recorded, are stale — their
      // worktree usually still exists on disk, so worktree liveness alone
      // would wedge the serial forever.
      if (claim.bootId === bootId && directoryExists(claim.worktreeRoot))
        throw new Error(`${serial} is claimed by ${claim.worktreeRoot}`);
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      if (error instanceof SyntaxError) {
        fs.rmSync(filePath, { force: true });
      } else if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // Missing claims can be created atomically below.
      } else if (error instanceof Error && error.message.includes(' is claimed by ')) {
        throw error;
      }
    }
    const claim = buildReadyClaim(serial, worktreeRoot, bootId);
    fs.writeFileSync(filePath, JSON.stringify(claim), { flag: 'wx' });
    return claim;
  });
}

function directoryExists(candidate: unknown): boolean {
  return typeof candidate === 'string' && fs.existsSync(candidate);
}

function buildReadyClaim(serial: string, worktreeRoot: string, bootId: string): DeviceClaim {
  return {
    serial,
    worktreeRoot,
    claimedAt: new Date().toISOString(),
    claimId: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: 'ready',
    bootId,
  };
}

function releaseAndroidDevice(serial: string, worktreeRoot: string): void {
  const filePath = claimPath(serial);
  withClaimMutationLock(filePath, () => {
    const claim = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DeviceClaim;
    if (claim.worktreeRoot !== worktreeRoot)
      throw new Error(`${serial} is claimed by ${claim.worktreeRoot}`);
    fs.rmSync(filePath);
  });
}

function releaseWorktreeAndroidDevices(worktreeRoot: string): string[] {
  const claimRoot = path.join(os.tmpdir(), 'kilo-mobile-android-claims');
  let entries: string[];
  try {
    entries = fs.readdirSync(claimRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const released: string[] = [];
  const failures: Error[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const serial = entry.slice(0, -'.json'.length);
    try {
      const claim = JSON.parse(fs.readFileSync(path.join(claimRoot, entry), 'utf8')) as DeviceClaim;
      if (claim.worktreeRoot !== worktreeRoot) continue;
      releaseAndroidDevice(serial, worktreeRoot);
      released.push(serial);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map(failure => failure.message).join('; '));
  return released;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const env = environment();
  const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  if (command === 'doctor' || command === undefined) {
    const avds = execFileSync(env.emulator, ['-list-avds'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: env.path, JAVA_HOME: env.javaHome },
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    console.log(JSON.stringify({ ...env, avds, worktree: path.basename(process.cwd()) }, null, 2));
    return;
  }
  const mobileRoot = path.join(worktreeRoot, 'apps/mobile');
  const cacheRoot = path.join(os.homedir(), 'Library/Caches/Kilo/mobile-android-builds');
  if (command === 'fingerprint') {
    if (args.length !== 0) throw new Error('Usage: pnpm dev:mobile:android fingerprint');
    const nativeHash = await createProjectHashAsync(mobileRoot, buildAndroidFingerprintOptions());
    const compatibility = {
      ...androidCompatibility(env, mobileRoot),
      nativeHash,
      buildMode: 'debug-dev-client' as const,
    };
    console.log(
      JSON.stringify(
        { key: buildAndroidCompatibilityKey(compatibility), ...compatibility },
        null,
        2
      )
    );
    return;
  }
  if (command === 'prune') {
    if (args.length !== 0) throw new Error('Usage: pnpm dev:mobile:android prune');
    console.log(JSON.stringify(pruneAndroidCache(cacheRoot), null, 2));
    return;
  }
  if (command === 'build') {
    const serial = args[0];
    if (!serial) throw new Error('Usage: pnpm dev:mobile:android build <serial>');
    const claimRoot = path.join(os.tmpdir(), 'kilo-mobile-android-claims');
    await runAndroidBuild(serial, {
      cacheRoot,
      claimRoot,
      worktreeRoot,
      mobileRoot,
      fingerprint: (root, options) => createProjectHashAsync(root, options),
      compatibility: () => androidCompatibility(env, mobileRoot),
      withNativeBuildSlot: runBuild =>
        withNativeBuildSemaphore({
          root: path.join(os.homedir(), 'Library/Caches/Kilo'),
          run: runBuild,
        }),
      build: staging => buildAndroidApk(env, mobileRoot, staging),
      fetchRemote: async ({ nativeHash, destDir }) => fetchAndroidApk({ nativeHash, destDir }),
      readPackageId: apkPath => readAndroidPackageId(env, apkPath),
      install: (deviceSerial, apkPath) => {
        const command = buildAndroidInstallCommand(env.adb, deviceSerial, apkPath);
        run(command.command, command.args, env);
      },
      now: () => new Date(),
    });
    console.log(`Installed ${serial}`);
    return;
  }
  if (command === 'emulator-start') {
    const { avd, gpu, wait } = parseEmulatorStartArgs(args);
    // One automatic relaunch encodes the launch/GPU policy the runbook used
    // to hand to callers: a missed boot envelope keeps the same GPU (the
    // process was healthy, the host was slow); every pre-boot launch failure
    // and mid-boot death switches to software rendering. A second failure is
    // the caller's test-environment blocker — never a third launch.
    const attempt = async (attemptGpu: string) => {
      const record = await startAndroidEmulator(env, worktreeRoot, avd, attemptGpu);
      if (wait) await waitForAndroidBoot(env, record);
      return record;
    };
    let record: EmulatorRecord;
    try {
      record = await attempt(gpu);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The already-exists guard is an instruction, not a launch failure: a
      // retry here would tear down a live emulator under whoever uses it.
      if (message.includes('already exists')) throw error;
      const bootEnvelopeMissed = message.includes('did not reach sys.boot_completed=1');
      const retryGpu = bootEnvelopeMissed ? gpu : 'swiftshader_indirect';
      console.error(
        `emulator-start attempt 1 failed: ${message}\nstopping leftovers and retrying once with --gpu ${retryGpu}`
      );
      try {
        await stopAndroidEmulator(env, worktreeRoot);
      } catch (stopError) {
        // Keep attempt 1's failure as the reason; never boot a second
        // emulator over state the teardown could not clear.
        console.error(
          `teardown after attempt 1 failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        );
        throw error;
      }
      try {
        record = await attempt(retryGpu);
      } catch (retryError) {
        // The second failure is the caller's blocker, but its emulator,
        // session, and record must not outlive it.
        try {
          await stopAndroidEmulator(env, worktreeRoot);
        } catch (stopError) {
          console.error(
            `teardown after attempt 2 failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
          );
        }
        throw retryError;
      }
    }
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  if (command === 'emulator-stop') {
    if (args.length !== 0) throw new Error('Usage: pnpm dev:mobile:android emulator-stop');
    await stopAndroidEmulator(env, worktreeRoot);
    console.log(`Stopped wrapper-owned emulator for ${path.basename(worktreeRoot)}`);
    return;
  }
  if (command === 'claim') {
    const serials = getAndroidSerials(env);
    const serial = args[0] ?? serials[0];
    if (!serial || !serials.includes(serial))
      throw new Error('No connected Android device is available');
    console.log(JSON.stringify(claimAndroidDevice(serial, worktreeRoot, readBootId(env, serial))));
    return;
  }
  if (command === 'release') {
    const serial = args[0];
    if (!serial) throw new Error('Usage: pnpm dev:mobile:android release <serial>');
    releaseAndroidDevice(serial, worktreeRoot);
    console.log(`Released ${serial}`);
    return;
  }
  if (command === 'release-all') {
    if (args.length !== 0) throw new Error('Usage: pnpm dev:mobile:android release-all');
    const released = releaseWorktreeAndroidDevices(worktreeRoot);
    console.log(
      released.length === 0
        ? `No Android device claimed by ${worktreeRoot}`
        : `Released ${released.join(' ')}`
    );
    return;
  }
  if (command === 'adb') return run(env.adb, args, env);
  if (command === 'emulator') return run(env.emulator, args, env);
  if (command === 'sdkmanager') {
    if (!env.sdkmanager) throw new Error('sdkmanager is not installed');
    return run(env.sdkmanager, args, env);
  }
  throw new Error(
    'Usage: pnpm dev:mobile:android [doctor|fingerprint|build|prune|claim|release|release-all|emulator-start|emulator-stop|adb|emulator|sdkmanager] [args...]'
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

function androidCompatibility(env: AndroidEnvironment, mobileRoot: string) {
  const gradleProject = path.join(mobileRoot, 'android');
  const gradlew = path.join(gradleProject, 'gradlew');
  if (!fs.existsSync(gradlew)) {
    throw new Error(
      `Generated Android project is missing at ${gradleProject}. Run \`npx expo prebuild --platform android\` in apps/mobile first.`
    );
  }
  const gradleVersion = readGradleWrapperVersion(gradleProject);
  const javaResult = spawnSync(path.join(env.javaHome, 'bin/java'), ['-version'], {
    encoding: 'utf8',
  });
  const javaVersion = `${javaResult.stdout}${javaResult.stderr}`.match(/version "([^"]+)"/)?.[1];
  if (!gradleVersion || !javaVersion)
    throw new Error('Unable to determine Android build toolchain');
  const platforms = listVersions(path.join(env.sdkRoot, 'platforms'));
  const buildTools = listVersions(path.join(env.sdkRoot, 'build-tools'));
  return {
    gradleVersion,
    javaVersion,
    androidSdkIdentity: `${platforms.at(-1) ?? 'none'}/${buildTools.at(-1) ?? 'none'}`,
    hostArch: process.arch,
  };
}

function readGradleWrapperVersion(androidRoot: string): string {
  const properties = fs.readFileSync(
    path.join(androidRoot, 'gradle/wrapper/gradle-wrapper.properties'),
    'utf8'
  );
  const version = properties.match(/gradle-([0-9][0-9.]*)-(?:all|bin)\.zip/)?.[1];
  if (!version) throw new Error('Unable to determine Gradle wrapper version');
  return version;
}

async function buildAndroidApk(
  env: AndroidEnvironment,
  mobileRoot: string,
  staging: string
): Promise<string> {
  const androidRoot = path.join(mobileRoot, 'android');
  const gradlew = path.join(androidRoot, 'gradlew');
  if (!fs.existsSync(gradlew)) {
    throw new Error(
      `Generated Android project is missing at ${androidRoot}. Run \`npx expo prebuild --platform android\` in apps/mobile first.`
    );
  }
  const sourceApk = path.join(androidRoot, 'app/build/outputs/apk/debug/app-debug.apk');
  fs.rmSync(sourceApk, { force: true });
  run(
    gradlew,
    [
      'app:assembleDebug',
      '--no-daemon',
      '--project-cache-dir',
      path.join(staging, 'project-cache'),
    ],
    env,
    androidRoot
  );
  if (!fs.existsSync(sourceApk)) {
    throw new Error(`Gradle did not produce the expected APK at ${sourceApk}`);
  }
  const stagedApk = path.join(staging, 'app-debug.apk');
  fs.copyFileSync(sourceApk, stagedApk);
  return stagedApk;
}

function readAndroidPackageId(env: AndroidEnvironment, apkPath: string): string | undefined {
  const buildTools = listVersions(path.join(env.sdkRoot, 'build-tools'));
  const version = buildTools.at(-1);
  if (!version) throw new Error('Android build-tools are not installed');
  const aapt = path.join(env.sdkRoot, 'build-tools', version, 'aapt');
  const output = execFileSync(aapt, ['dump', 'badging', apkPath], {
    encoding: 'utf8',
    env: androidProcessEnv(env),
  });
  return output.match(/^package: name='([^']+)'/m)?.[1];
}

function listVersions(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function androidProcessEnv(env: AndroidEnvironment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANDROID_HOME: env.sdkRoot,
    ANDROID_SDK_ROOT: env.sdkRoot,
    JAVA_HOME: env.javaHome,
    PATH: env.path,
  };
}

export {
  androidEmulatorSession,
  claimAndroidDevice,
  commandMatchesRecordedEmulator,
  DEFAULT_CONSOLE_PORT_WAIT_MS,
  findAvailableEmulatorPort,
  isValidEmulatorRecord,
  parseEmulatorStartArgs,
  processOwnsListeningPort,
  readGradleWrapperVersion,
  releaseAndroidDevice,
  releaseWorktreeAndroidDevices,
  resolveAndroidEnvironment,
  signalProcessIfPresent,
  startAndroidEmulator,
};
export type { AndroidEnvironment };
