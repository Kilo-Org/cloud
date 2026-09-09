import { constants, type Stats } from 'fs';
import { lstat, open, realpath, type FileHandle } from 'fs/promises';
import { dirname, join } from 'path';
import type { WorktreeFileRecord } from '../../../src/shared/worktree-changes-wire.js';

export type FileOmissionReason = Extract<
  WorktreeFileRecord['diff'],
  { status: 'omitted' }
>['reason'];

export class WorktreeFileCaptureError extends Error {
  constructor(readonly reason: FileOmissionReason) {
    super('Worktree capture failed');
  }
}

export type WorktreeFileState = {
  path: string;
  parents: Array<{ path: string; stat: Stats | undefined }>;
  stat: Stats | undefined;
  deleted: boolean;
};

export function sameFile(before: Stats | undefined, after: Stats | undefined): boolean {
  if (!before || !after) return before === after;
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function statOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function inspectWorktreeFile(
  root: string,
  path: string,
  deleted = false
): Promise<WorktreeFileState> {
  const parents: WorktreeFileState['parents'] = [];
  const parentPaths = [root];
  while (dirname(parentPaths[0]) !== parentPaths[0]) {
    parentPaths.unshift(dirname(parentPaths[0]));
  }
  if (!deleted) {
    let directory = root;
    for (const part of path.split('/').slice(0, -1)) {
      directory = join(directory, part);
      parentPaths.push(directory);
    }
  }
  for (const parent of parentPaths) {
    const stat = await statOrMissing(parent);
    parents.push({ path: parent, stat });
    if (!stat) {
      if (!deleted) throw new WorktreeFileCaptureError('inconsistent');
      return { path: join(root, path), parents, stat: undefined, deleted };
    }
    if (!stat.isDirectory() || (await realpath(parent)) !== parent) {
      throw new WorktreeFileCaptureError('unsupported');
    }
  }
  const fullPath = join(root, path);
  const stat = deleted ? undefined : await statOrMissing(fullPath);
  if (!deleted && !stat) throw new WorktreeFileCaptureError('inconsistent');
  if (stat && !stat.isFile()) throw new WorktreeFileCaptureError('unsupported');
  return { path: fullPath, parents, stat, deleted };
}

export async function verifyWorktreeFile(state: WorktreeFileState): Promise<void> {
  for (const parent of state.parents) {
    const current = await statOrMissing(parent.path);
    if (
      parent.stat?.dev !== current?.dev ||
      parent.stat?.ino !== current?.ino ||
      parent.stat?.mode !== current?.mode
    ) {
      throw new WorktreeFileCaptureError('inconsistent');
    }
    if (parent.stat && (await realpath(parent.path)) !== parent.path) {
      throw new WorktreeFileCaptureError('inconsistent');
    }
  }
  if (!state.deleted && !sameFile(state.stat, await statOrMissing(state.path))) {
    throw new WorktreeFileCaptureError('inconsistent');
  }
}

export async function withStableWorktreeFile<T>(
  state: WorktreeFileState,
  remainingTime: () => number,
  read: (handle: FileHandle) => Promise<T>
): Promise<T> {
  const before = state.stat;
  if (!before?.isFile()) throw new WorktreeFileCaptureError('unsupported');
  remainingTime();
  await verifyWorktreeFile(state);
  const handle = await open(
    state.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!sameFile(before, await handle.stat())) throw new WorktreeFileCaptureError('inconsistent');
    const result = await read(handle);
    if (!sameFile(before, await handle.stat())) throw new WorktreeFileCaptureError('inconsistent');
    await verifyWorktreeFile(state);
    remainingTime();
    return result;
  } finally {
    await handle.close();
  }
}

export async function readWorktreeFile(
  state: WorktreeFileState,
  maxBytes: number,
  remainingTime: () => number
): Promise<Buffer> {
  const before = state.stat;
  if (!before?.isFile()) throw new WorktreeFileCaptureError('unsupported');
  if (before.size > maxBytes) throw new WorktreeFileCaptureError('too_large');
  return withStableWorktreeFile(state, remainingTime, async handle => {
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      remainingTime();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new WorktreeFileCaptureError('inconsistent');
      offset += bytesRead;
    }
    return bytes;
  });
}

export function decodeWorktreeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorktreeFileCaptureError('invalid_utf8');
  }
}

export function isBinary(bytes: Uint8Array): boolean {
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return bytes.length > 0 && controls / bytes.length > 0.3;
}

export function lineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 10) lines += 1;
  }
  return lines + (bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? 1 : 0);
}

export function fileOmissionReason(error: unknown): FileOmissionReason {
  return error instanceof WorktreeFileCaptureError ? error.reason : 'capture_failed';
}
