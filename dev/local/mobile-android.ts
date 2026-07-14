import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

type DeviceClaim = { serial: string; worktreeRoot: string; claimedAt: string };

function firstExisting(
  candidates: string[],
  exists: (candidate: string) => boolean
): string | undefined {
  return candidates.find(exists);
}

function resolveAndroidEnvironment(args: ResolveArgs): AndroidEnvironment {
  const exists = args.existingPaths
    ? (candidate: string) => args.existingPaths!.has(candidate)
    : fs.existsSync;
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(args.home, 'Library/Android/sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
  ].filter((value): value is string => Boolean(value));
  const sdkRoot = sdkRoots.find(root =>
    firstExisting(
      [path.join(root, 'platform-tools/adb'), path.join(root, 'emulator/emulator')],
      exists
    )
  );
  if (!sdkRoot) {
    throw new Error(
      'Android SDK not found in ANDROID_HOME, ~/Library/Android/sdk, or Homebrew android-commandlinetools. Run: brew install --cask android-commandlinetools'
    );
  }

  const adb = firstExisting([path.join(sdkRoot, 'platform-tools/adb')], exists);
  const emulator = firstExisting([path.join(sdkRoot, 'emulator/emulator')], exists);
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

  const missing = [!adb && 'adb', !emulator && 'emulator', !javaHome && 'JDK 17'].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Android tooling incomplete: missing ${missing.join(', ')}`);
  }

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

function claimPath(serial: string): string {
  return path.join(
    os.tmpdir(),
    'kilo-mobile-android-claims',
    `${serial.replaceAll('/', '_')}.json`
  );
}

function claimAndroidDevice(serial: string, worktreeRoot: string): DeviceClaim {
  const filePath = claimPath(serial);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const claim = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DeviceClaim;
    if (claim.worktreeRoot === worktreeRoot) return claim;
    if (fs.existsSync(claim.worktreeRoot))
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
  const claim = { serial, worktreeRoot, claimedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(claim), { flag: 'wx' });
  return claim;
}

function releaseAndroidDevice(serial: string, worktreeRoot: string): void {
  const filePath = claimPath(serial);
  const claim = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DeviceClaim;
  if (claim.worktreeRoot !== worktreeRoot)
    throw new Error(`${serial} is claimed by ${claim.worktreeRoot}`);
  fs.rmSync(filePath);
}

function main(): void {
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
  if (command === 'build') {
    return run(
      'npx',
      ['expo', 'run:android', '--no-install', '--no-bundler', ...args],
      env,
      path.join(worktreeRoot, 'apps/mobile')
    );
  }
  if (command === 'claim') {
    const requested = args[0];
    const serial = requested ?? getAndroidSerials(env)[0];
    if (!serial || !getAndroidSerials(env).includes(serial))
      throw new Error('No connected Android device is available');
    console.log(JSON.stringify(claimAndroidDevice(serial, worktreeRoot)));
    return;
  }
  if (command === 'release') {
    const serial = args[0];
    if (!serial) throw new Error('Usage: pnpm dev:mobile:android release <serial>');
    releaseAndroidDevice(serial, worktreeRoot);
    console.log(`Released ${serial}`);
    return;
  }
  if (command === 'adb') return run(env.adb, args, env);
  if (command === 'emulator') return run(env.emulator, args, env);
  if (command === 'sdkmanager') {
    if (!env.sdkmanager) throw new Error('sdkmanager is not installed');
    return run(env.sdkmanager, args, env);
  }
  throw new Error(
    'Usage: pnpm dev:mobile:android [doctor|build|claim|release|adb|emulator|sdkmanager] [args...]'
  );
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

export { claimAndroidDevice, releaseAndroidDevice, resolveAndroidEnvironment };
export type { AndroidEnvironment };
