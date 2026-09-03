import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

async function verifyParents(path: string): Promise<void> {
  let parent = dirname(path);
  for (;;) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
      throw new Error('unsafe_parent_directory');
    if (parent === dirname(parent)) return;
    parent = dirname(parent);
  }
}

export async function readPrivate(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('absolute_private_path_required');
  await verifyParents(path);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    info.size > 1_048_576
  )
    throw new Error('private_file_required');
  return readFile(path, 'utf8');
}

export async function privateOutput(path: string, value: string): Promise<void> {
  await verifyParents(path);
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new Error('private_output_required');
    await writeFile(path, value, { mode: 0o600 });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeFile(path, value, { mode: 0o600, flag: 'wx' });
  }
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function run(command: string[], workdir?: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: workdir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
    env: {
      ...process.env,
      KUBECONFIG: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
    },
  });
  const [output, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 || output.length > 8 * 1_048_576) throw new Error('local_command_failed');
  return output;
}

export async function prepareRunDirectory(
  repositoryRoot: string,
  runDirectory: string,
  outputName: string
): Promise<void> {
  const allowedRoot = join(repositoryRoot, '.tmp');
  const local = relative(allowedRoot, runDirectory);
  if (!isAbsolute(runDirectory) || !local || local.startsWith('..') || isAbsolute(local))
    throw new Error('ignored_run_directory_required');
  await run(
    ['git', 'check-ignore', '--quiet', '--', join(runDirectory, outputName)],
    repositoryRoot
  );
  const parts = relative(repositoryRoot, runDirectory).split('/');
  let path = repositoryRoot;
  for (const part of parts) {
    const next = join(path, part);
    const parent = await lstat(path);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0)
      throw new Error('unsafe_run_directory_parent');
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const info = await lstat(next);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o022) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new Error('unsafe_run_directory');
    path = next;
  }
  if (((await lstat(runDirectory)).mode & 0o077) !== 0)
    throw new Error('private_run_directory_required');
}
