import fs from 'node:fs/promises';
import path from 'node:path';
import {
  stripGitCredentials,
  truncateWrapperLog,
  type WorkspaceGit,
} from '../control-plane/workspace-adoption.js';

/**
 * Pre-capture cleanup (plan "Build admission and execution", steps 6 and 7).
 * Setup descendants are stopped so nothing rewrites a file while the platform
 * snapshots the container, then platform-managed credential material is removed
 * from the workspace and the fixed home. Caches and toolchains stay. A cleanup
 * that cannot be completed or verified fails the build instead of capturing.
 *
 * Setup commands can still write a secret into an arbitrary file; known paths
 * are all that cleanup can prove. Snapshot contents stay sensitive environment
 * data (plan "Credentials and snapshot contents").
 */

/** Git credential files a setup or the platform may leave in the fixed home. */
export const HOME_CREDENTIAL_FILES = [
  '.git-credentials',
  path.join('.config', 'git', 'credentials'),
] as const;

const STOP_GRACE_MS = 2_000;

/**
 * Stop every other process in the container. The builder is PID 1, so
 * `kill(-1)` reaches every process except itself; the call is refused anywhere
 * else, so a test or a misconfigured start cannot signal a host.
 */
export async function stopOtherProcesses(
  deps: {
    pid?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const pid = deps.pid ?? process.pid;
  if (pid !== 1) throw new Error('Refusing to stop processes outside a builder container');
  const kill = deps.kill ?? ((target, signal) => process.kill(target, signal));
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const signalAll = (signal: NodeJS.Signals): void => {
    try {
      kill(-1, signal);
    } catch (error) {
      // ESRCH: no other process exists.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signalAll('SIGTERM');
  await sleep(STOP_GRACE_MS);
  signalAll('SIGKILL');
}

export type CleanupInput = {
  git: WorkspaceGit;
  directory: string;
  home: string;
  /** The credential-free repository URL `origin` is left at. */
  bareUrl: string;
  /** Build-scoped values that must not remain in Git metadata. */
  canaries: readonly string[];
  logPath: string | undefined;
};

/** Files whose text can carry a URL-bound credential after a clone and fetch. */
function gitMetadataFiles(directory: string, home: string): string[] {
  return [
    path.join(directory, '.git', 'config'),
    path.join(directory, '.git', 'FETCH_HEAD'),
    path.join(directory, '.git', 'packed-refs'),
    path.join(home, '.gitconfig'),
    path.join(home, '.config', 'git', 'config'),
    ...HOME_CREDENTIAL_FILES.map(file => path.join(home, file)),
  ];
}

async function containsCanary(file: string, canaries: readonly string[]): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return canaries.some(canary => canary.length > 0 && text.includes(canary));
}

/**
 * Leave no credential in Git metadata, the known home credential files or the
 * builder log, then verify it. Returns a safe failure phrase, or null when the
 * workspace may be captured.
 */
export async function removeBuildCredentials(input: CleanupInput): Promise<string | null> {
  const bare = await stripGitCredentials({
    git: input.git,
    directory: input.directory,
    bareUrl: input.bareUrl,
  });
  if (!bare) return 'repository credential could not be removed';
  try {
    for (const file of HOME_CREDENTIAL_FILES) {
      await fs.rm(path.join(input.home, file), { force: true });
    }
  } catch {
    return 'home credential files could not be removed';
  }
  await truncateWrapperLog(input.logPath);
  try {
    for (const file of gitMetadataFiles(input.directory, input.home)) {
      if (await containsCanary(file, input.canaries))
        return 'a credential remained in Git metadata';
    }
  } catch {
    return 'credential cleanup could not be verified';
  }
  return null;
}
