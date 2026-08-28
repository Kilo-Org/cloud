// Fetch prebuilt native artifacts from the `mobile-native-build` GitHub
// workflow so a host installs a cached binary instead of compiling one.
// The artifact is keyed by the platform's input-deterministic nativeHash
// (see buildFingerprintOptions / buildAndroidFingerprintOptions), so any
// machine that computes the same hash can reuse the same binary.
//
// Every failure path returns false/undefined so the caller falls back to
// the local build — the failure path stays today's path. Set
// KILO_REMOTE_NATIVE=off to skip remote fetching entirely.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKFLOW_FILE = 'mobile-native-build.yml';
// A queued + running macOS build fits well inside this; a hung run must not
// pin an agent forever, so time out and build locally.
const WATCH_TIMEOUT_MS = 45 * 60 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
// Artifact zips run to a few hundred MB.
const DOWNLOAD_MAX_BUFFER = 2 * 1024 * 1024 * 1024;

export function remoteNativeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KILO_REMOTE_NATIVE === 'off';
}

export function artifactName(platform: 'ios' | 'android', nativeHash: string): string {
  return `mobile-native-${platform}-${nativeHash}`;
}

function log(message: string): void {
  process.stderr.write(`mobile-remote-native: ${message}\n`);
}

function gh(args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? GH_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

type ArtifactRecord = { id: number; expired: boolean };

function findArtifact(name: string): ArtifactRecord | undefined {
  // `gh api` resolves {owner}/{repo} from the current repository. Name
  // lookup returns newest first across all workflow runs.
  const raw = gh(['api', `repos/{owner}/{repo}/actions/artifacts?name=${name}&per_page=10`]);
  const parsed = JSON.parse(raw) as { artifacts?: Array<{ id: number; expired: boolean }> };
  return parsed.artifacts?.find(artifact => !artifact.expired);
}

// Download an artifact zip and hand the caller its unpacked directory.
// Returns false when the artifact does not exist (after a dispatch attempt)
// or anything in the chain fails.
function withArtifact(
  platform: 'ios' | 'android',
  nativeHash: string,
  use: (unpackedDir: string) => void
): boolean {
  if (remoteNativeDisabled()) return false;
  const name = artifactName(platform, nativeHash);
  let artifact: ArtifactRecord | undefined;
  try {
    artifact = findArtifact(name);
  } catch (error) {
    // No gh, no auth, or no network: local build is the fallback.
    log(`artifact lookup failed (${message(error)})`);
    return false;
  }
  if (!artifact) {
    log(`no artifact ${name}; trying a remote build dispatch`);
    if (!dispatchAndWatch(platform)) return false;
    try {
      artifact = findArtifact(name);
    } catch (error) {
      log(`artifact lookup failed after dispatch (${message(error)})`);
      return false;
    }
    if (!artifact) {
      // The dispatched run built a different hash (local uncommitted native
      // changes) or uploaded nothing.
      log(`remote build finished but produced no artifact ${name}`);
      return false;
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-remote-native-'));
  try {
    const zipPath = path.join(scratch, 'artifact.zip');
    const zip = execFileSync(
      'gh',
      ['api', `repos/{owner}/{repo}/actions/artifacts/${artifact.id}/zip`],
      { maxBuffer: DOWNLOAD_MAX_BUFFER, timeout: 10 * 60 * 1000 }
    );
    fs.writeFileSync(zipPath, zip);
    const unpacked = path.join(scratch, 'unpacked');
    fs.mkdirSync(unpacked);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', unpacked], { stdio: 'ignore' });
    use(unpacked);
    log(`installed remote artifact ${name}`);
    return true;
  } catch (error) {
    log(`artifact download failed (${message(error)})`);
    return false;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

type DispatchRun = { databaseId: number; headSha: string };

function listDispatchRuns(branch: string): DispatchRun[] {
  const raw = gh([
    'run',
    'list',
    '--workflow',
    WORKFLOW_FILE,
    '--branch',
    branch,
    '--event',
    'workflow_dispatch',
    '--limit',
    '30',
    '--json',
    'databaseId,headSha',
  ]);
  return JSON.parse(raw) as DispatchRun[];
}

// `gh workflow run` reports no run id, and no listing exposes the dispatch
// inputs, so take the newest run on this commit that did not exist before
// the dispatch. `gh run list` returns newest first. Two hosts dispatching
// different platforms in the same poll window can still cross; that ends in
// the local build, which is the fallback anyway.
export function pickDispatchedRun(
  runs: DispatchRun[],
  before: ReadonlySet<number>,
  headSha: string
): number | undefined {
  return runs.find(run => !before.has(run.databaseId) && run.headSha === headSha)?.databaseId;
}

// Dispatch the workflow for the current branch and wait for it to finish.
// Only possible when HEAD is exactly the pushed upstream commit — the
// runner builds from the remote ref, so anything else builds the wrong tree.
function dispatchAndWatch(platform: 'ios' | 'android'): boolean {
  const startedAt = Date.now();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    log('detached HEAD; cannot dispatch a remote build');
    return false;
  }
  const head = git(['rev-parse', 'HEAD']);
  const upstream = git(['rev-parse', '@{u}']);
  if (!head || !upstream || head !== upstream) {
    log(`branch ${branch} is not pushed to its upstream; cannot dispatch a remote build`);
    return false;
  }
  let before: Set<number>;
  try {
    before = new Set(listDispatchRuns(branch).map(run => run.databaseId));
  } catch (error) {
    log(`cannot list existing runs (${message(error)})`);
    return false;
  }
  try {
    gh(['workflow', 'run', WORKFLOW_FILE, '--ref', branch, '-f', `platform=${platform}`]);
  } catch (error) {
    // Typical cause: the workflow is not on the default branch yet —
    // workflow_dispatch only resolves workflows registered there.
    log(`workflow dispatch failed (${message(error)})`);
    return false;
  }
  log(`dispatched ${WORKFLOW_FILE} for ${platform} on ${branch}; waiting for the run`);
  let runId: number | undefined;
  for (let attempt = 0; attempt < 12 && runId === undefined; attempt++) {
    sleepSync(5000);
    try {
      runId = pickDispatchedRun(listDispatchRuns(branch), before, head);
    } catch {
      // Keep polling; the run can lag the dispatch.
    }
  }
  if (runId === undefined) {
    log('dispatched run never appeared');
    return false;
  }
  try {
    execFileSync('gh', ['run', 'watch', String(runId), '--exit-status', '--interval', '30'], {
      stdio: ['ignore', process.stderr, process.stderr],
      timeout: WATCH_TIMEOUT_MS,
    });
    log(`remote build run ${runId} finished after ${waited(startedAt)}`);
    return true;
  } catch (error) {
    log(
      `remote build run ${runId} failed or timed out after ${waited(startedAt)} (${message(error)})`
    );
    return false;
  }
}

// Wall clock spent waiting on CI. Waiting only pays while it stays under a
// local compile; log it so that stays measurable instead of assumed.
function waited(since: number): string {
  return `${((Date.now() - since) / 60000).toFixed(1)}m`;
}

export type IosToolchain = { xcodeBuildVersion: string; simulatorSdkVersion: string };

// The artifact name keys on nativeHash alone, but the local cache key also
// keys on the Xcode and simulator SDK that produced the binary. Without this
// check a host publishes a runner-built .app under its own toolchain's key;
// when the runner's simulator SDK is newer than the host's runtime the app
// never launches, and the entry sticks under a key the host keeps
// recomputing. Throwing here drops us onto the local build instead.
export function assertToolchainMatches(actual: unknown, expected: IosToolchain): void {
  const found = actual as Partial<IosToolchain> | null;
  if (
    !found ||
    found.xcodeBuildVersion !== expected.xcodeBuildVersion ||
    found.simulatorSdkVersion !== expected.simulatorSdkVersion
  ) {
    throw new Error(
      `artifact toolchain ${found?.xcodeBuildVersion}/${found?.simulatorSdkVersion} does not match local ${expected.xcodeBuildVersion}/${expected.simulatorSdkVersion}`
    );
  }
}

// Unpack a remote iOS artifact's Kilo.app into the products directory the
// local build pipeline reads from. The artifact carries a tarball because
// upload-artifact's zip drops the executable bit.
export function fetchIosApp(args: {
  nativeHash: string;
  productsDir: string;
  toolchain: IosToolchain;
}): boolean {
  return withArtifact('ios', args.nativeHash, unpacked => {
    const tarball = path.join(unpacked, `ios-${args.nativeHash}.tar.gz`);
    if (!fs.existsSync(tarball))
      throw new Error(`artifact is missing ios-${args.nativeHash}.tar.gz`);
    // Read the toolchain first, into scratch, so productsDir only ever
    // receives Kilo.app. An artifact built before toolchain.json existed
    // fails this extract, which is the same fall-back-to-local path.
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked, 'toolchain.json'], { stdio: 'ignore' });
    assertToolchainMatches(
      JSON.parse(fs.readFileSync(path.join(unpacked, 'toolchain.json'), 'utf8')),
      args.toolchain
    );
    execFileSync('tar', ['-xzf', tarball, '-C', args.productsDir, 'Kilo.app'], { stdio: 'ignore' });
    if (!fs.existsSync(path.join(args.productsDir, 'Kilo.app'))) {
      throw new Error('artifact tarball did not contain Kilo.app');
    }
  });
}

// Copy a remote Android artifact's Kilo.apk into destDir and return its path.
export function fetchAndroidApk(args: { nativeHash: string; destDir: string }): string | undefined {
  const target = path.join(args.destDir, 'Kilo-remote.apk');
  const ok = withArtifact('android', args.nativeHash, unpacked => {
    const apk = path.join(unpacked, 'Kilo.apk');
    if (!fs.existsSync(apk)) throw new Error('artifact is missing Kilo.apk');
    fs.copyFileSync(apk, target);
  });
  return ok ? target : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}
