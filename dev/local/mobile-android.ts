import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type AndroidEnvironment = {
  adb: string;
  emulator: string;
  javaHome: string;
  path: string;
  sdkRoot: string;
  sdkmanager: string;
};

type ResolveArgs = {
  home: string;
  path: string;
  existingPaths?: ReadonlySet<string>;
};

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
    process.env.JAVA_HOME,
    '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home',
    '/opt/homebrew/opt/temurin@17/libexec/openjdk.jdk/Contents/Home',
  ].filter((value): value is string => Boolean(value));
  const javaHome = javaHomes.find(candidate => exists(path.join(candidate, 'bin/java')));

  const missing = [
    !adb && 'adb',
    !emulator && 'emulator',
    !sdkmanager && 'sdkmanager',
    !javaHome && 'JDK 17',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Android tooling incomplete: missing ${missing.join(', ')}`);
  }

  const toolPaths = [
    path.join(sdkRoot, 'platform-tools'),
    path.join(sdkRoot, 'emulator'),
    path.dirname(sdkmanager),
    path.join(javaHome, 'bin'),
  ];
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

function run(command: string, args: string[], env: AndroidEnvironment): void {
  execFileSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANDROID_HOME: env.sdkRoot,
      ANDROID_SDK_ROOT: env.sdkRoot,
      JAVA_HOME: env.javaHome,
      PATH: env.path,
    },
  });
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const env = environment();
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
  if (command === 'adb') return run(env.adb, args, env);
  if (command === 'emulator') return run(env.emulator, args, env);
  if (command === 'sdkmanager') return run(env.sdkmanager, args, env);
  throw new Error('Usage: pnpm dev:mobile:android [doctor|adb|emulator|sdkmanager] [args...]');
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

export { resolveAndroidEnvironment };
export type { AndroidEnvironment };
