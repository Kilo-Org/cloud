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
import { withProcessLock } from './process-lock';

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
};
type ClaimOptions = {
  fileOperations?: {
    readFileSync?: (filePath: string, encoding: 'utf8') => string;
  };
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

function withClaimMutationLock<T>(filePath: string, mutate: () => T): T {
  const lockFilePath = `${filePath}.lock`;
  return withProcessLock(lockFilePath, `${path.basename(filePath, '.json')} claim`, mutate);
}

function claimAndroidDevice(
  serial: string,
  worktreeRoot: string,
  options?: ClaimOptions
): DeviceClaim {
  const filePath = claimPath(serial);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return withClaimMutationLock(filePath, () => {
    try {
      const readFileSync = options?.fileOperations?.readFileSync ?? fs.readFileSync;
      const claim = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DeviceClaim>;
      if (claim.worktreeRoot === worktreeRoot) {
        if (claim.status === 'ready' && typeof claim.claimId === 'string')
          return claim as DeviceClaim;
        const upgraded = buildReadyClaim(serial, worktreeRoot);
        fs.writeFileSync(filePath, JSON.stringify(upgraded));
        return upgraded;
      }
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
    const claim = buildReadyClaim(serial, worktreeRoot);
    fs.writeFileSync(filePath, JSON.stringify(claim), { flag: 'wx' });
    return claim;
  });
}

function buildReadyClaim(serial: string, worktreeRoot: string): DeviceClaim {
  return {
    serial,
    worktreeRoot,
    claimedAt: new Date().toISOString(),
    claimId: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: 'ready',
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
    'Usage: pnpm dev:mobile:android [doctor|fingerprint|build|prune|claim|release|adb|emulator|sdkmanager] [args...]'
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
  claimAndroidDevice,
  readGradleWrapperVersion,
  releaseAndroidDevice,
  resolveAndroidEnvironment,
};
export type { AndroidEnvironment };
