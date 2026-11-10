import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The owned Git process group includes checkout hooks; abort waits for it to close. */
export async function baselineGit(
  repo: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const result = Promise.withResolvers<string>();
  const child = spawn('git', ['-C', repo, ...args], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failure: unknown;
  let killTimer: NodeJS.Timeout | undefined;
  const kill = (name: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error;
    }
  };
  const stop = (reason: unknown) => {
    if (failure !== undefined) return;
    failure = reason;
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
  };
  const abort = () => stop(signal?.reason ?? new Error('Baseline Git aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(
    () => stop(new Error(`Baseline Git exceeded 30000 ms: ${args[0]}`)),
    30_000
  );
  const collect = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) stop(new Error('Baseline Git output exceeds 16 MiB'));
    else target.push(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
  child.once('error', error => {
    failure = error;
  });
  child.once('close', code => {
    // A hook may have redirected its own stdio; terminate any surviving group
    // members even when Git closes before the escalation timer fires.
    if (failure !== undefined) kill('SIGKILL');
    clearTimeout(deadline);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    if (failure !== undefined) result.reject(failure);
    else if (code !== 0)
      result.reject(
        new Error(`Baseline Git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString()}`)
      );
    else result.resolve(Buffer.concat(stdout).toString());
  });
  if (signal?.aborted === true) abort();
  return result.promise;
}

/** Checking only the leaf misses tracked symlink directories such as app/(auth). */
export function containedProofSource(
  root: string,
  relative: string,
  createParents = false
): string {
  const directory = fs.realpathSync(root);
  const rootEntry = fs.lstatSync(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
    throw new Error('Proof worktree root is not a real directory');
  const destination = path.resolve(directory, relative);
  if (!destination.startsWith(`${directory}${path.sep}`))
    throw new Error('Proof source escapes its worktree');
  let ancestor = directory;
  for (const part of path.relative(directory, path.dirname(destination)).split(path.sep)) {
    if (part.length === 0) continue;
    ancestor = path.join(ancestor, part);
    if (createParents && !fs.existsSync(ancestor)) fs.mkdirSync(ancestor);
    const entry = fs.lstatSync(ancestor);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !fs.realpathSync(ancestor).startsWith(`${directory}${path.sep}`)
    ) {
      throw new Error(`Proof source ancestor is not a contained real directory: ${ancestor}`);
    }
  }
  if (fs.existsSync(destination)) {
    const leaf = fs.lstatSync(destination);
    if (
      !leaf.isFile() ||
      leaf.isSymbolicLink() ||
      !fs.realpathSync(destination).startsWith(`${directory}${path.sep}`)
    ) {
      throw new Error(`Proof source destination is not a contained regular file: ${relative}`);
    }
  } else if (!createParents) {
    throw new Error(`Prepared proof source is missing: ${relative}`);
  }
  return destination;
}
