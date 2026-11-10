import fs from 'node:fs/promises';
import {
  ENVIRONMENT_BUILD_RUNNER_PATH,
  environmentBuildRunnerSchema,
  type EnvironmentBuildRunner,
} from '../../../src/shared/environment-build-protocol.js';

/** The container DO writes the file right after the start; this bounds the wait. */
export const RUNNER_FILE_WAIT_MS = 2 * 60_000;
const RUNNER_FILE_POLL_MS = 200;

export type RunnerFileDeps = {
  path?: string;
  readFile?: (path: string) => Promise<string>;
  remove?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
};

/**
 * Wait for the runner file, read it once and delete it, so the endpoint and
 * credential live only in this process's memory before setup runs. Returns
 * null when no valid file arrives within the wait.
 */
export async function takeRunner(
  deps: RunnerFileDeps = {}
): Promise<EnvironmentBuildRunner | null> {
  const file = deps.path ?? ENVIRONMENT_BUILD_RUNNER_PATH;
  const readFile = deps.readFile ?? (target => fs.readFile(target, 'utf8'));
  const remove = deps.remove ?? (target => fs.rm(target, { force: true }));
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.waitMs ?? RUNNER_FILE_WAIT_MS);
  for (;;) {
    let text: string;
    try {
      text = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (now() >= deadline) return null;
      await sleep(RUNNER_FILE_POLL_MS);
      continue;
    }
    // Mark consumption before deleting: launch retries must not recreate the credential.
    await fs.writeFile(`${file}.consumed`, '', { mode: 0o600 });
    await remove(file);
    try {
      const parsed = environmentBuildRunnerSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
