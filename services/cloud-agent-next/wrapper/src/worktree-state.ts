import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  WORKTREE_STATE_BUNDLE_VERSION,
  WORKTREE_STATE_MAX_BYTES,
  WORKTREE_STATE_MAX_UNTRACKED_FILES,
  WORKTREE_STATE_META_ENTRY,
  WORKTREE_STATE_PATCH_ENTRY,
  WORKTREE_STATE_UNTRACKED_PREFIX,
  worktreeStateMetaSchema,
  type WorktreeStateMeta,
} from '../../src/shared/worktree-state.js';
import { git, logToFile, type ExecResult } from './utils.js';

/**
 * Captures and restores the uncommitted contents of a worktree so that
 * replacing the shared physical sandbox — the control plane stops it after five
 * idle minutes — no longer discards the agent's in-progress work.
 *
 * The bundle holds a `git diff HEAD --binary` patch plus the untracked files
 * git reports, which keeps `.gitignore`d dependency and build directories out
 * of it; setup commands recreate those on the rebuilt sandbox anyway.
 */

const GIT_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 60_000;
const DISCARD_TIMEOUT_MS = 10_000;
/**
 * Uncompressed ceiling for the staged bundle. Beyond this the dirty state is
 * treated as un-capturable rather than spending the whole idle window on it.
 */
const MAX_STAGED_BYTES = 64 * 1024 * 1024;

export type WorktreeStateEndpoint = {
  url: string;
  grant: string;
};

export type WorktreeStateOptions = {
  directory: string;
  endpoint: WorktreeStateEndpoint;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

export type WorktreeStateCaptureResult =
  | { status: 'captured'; bytes: number; files: number }
  | { status: 'skipped'; reason: string };

export type WorktreeStateRestoreResult =
  | { status: 'restored'; files: number }
  | { status: 'skipped'; reason: string };

function runGit(
  args: string[],
  options: WorktreeStateOptions,
  maxOutputBytes?: number
): Promise<ExecResult> {
  const { env, signal } = options;
  return git(args, {
    cwd: options.directory,
    ...(env ? { env, inheritEnv: false } : {}),
    timeoutMs: GIT_TIMEOUT_MS,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Streams a subprocess' stdout straight to disk so large output never lands in
 * the heap, giving up once `limit` bytes have been written: a worktree whose
 * diff alone would not fit is not worth filling the sandbox's disk for.
 */
function spawnToFile(
  command: string,
  args: string[],
  destination: string,
  options: WorktreeStateOptions,
  limit = MAX_STAGED_BYTES
): Promise<number> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination);
    const child = spawn(command, args, {
      cwd: options.directory,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let written = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill();
      output.destroy();
      reject(error);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      written += chunk.byteLength;
      if (written > limit) fail(new Error(`${command} output exceeded the ${limit} byte ceiling`));
    });
    child.stdout.pipe(output);
    child.on('error', fail);
    output.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      output.end(() =>
        code === 0 ? resolve(code) : reject(new Error(`${command} exited ${code}`))
      );
    });
  });
}

/**
 * Decompresses the bundle with a hard ceiling on the output. The producer caps
 * the staged bytes, but the restore must not trust that: a bundle that expands
 * past the ceiling is refused rather than filling the rebuilt sandbox's disk.
 */
async function gunzipBounded(source: string, destination: string, limit: number): Promise<void> {
  let written = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.byteLength;
      if (written > limit) {
        callback(new Error('bundle exceeds the decompressed ceiling'));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(source), createGunzip(), bound, createWriteStream(destination));
}

async function headCommit(options: WorktreeStateOptions): Promise<string | undefined> {
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], options);
  const commit = head.stdout.trim();
  return head.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(commit) ? commit : undefined;
}

/**
 * Untracked paths as git sees them, so `.gitignore` decides what is worth
 * preserving. Paths are NUL-separated to survive spaces and newlines.
 */
async function untrackedPaths(options: WorktreeStateOptions): Promise<string[] | undefined> {
  const listed = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    options,
    4 * 1024 * 1024
  );
  if (listed.exitCode !== 0 || listed.stdoutTruncated) return undefined;
  return listed.stdout.split('\0').filter(entry => entry.length > 0);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The directory an untracked file may be written into, or undefined when it
 * would land outside the worktree. The patch is applied before untracked files
 * are put back and can introduce a symlink, so containment is decided on the
 * resolved nearest existing ancestor rather than on the joined path; the
 * components below it do not exist yet and are created here.
 */
async function writableParent(root: string, destination: string): Promise<string | undefined> {
  const parent = path.dirname(destination);
  let ancestor = parent;
  while (true) {
    const resolved = await fs.realpath(ancestor).catch(() => undefined);
    if (resolved !== undefined) {
      return resolved === root || isContainedPath(root, resolved) ? parent : undefined;
    }
    const next = path.dirname(ancestor);
    if (next === ancestor) return undefined;
    ancestor = next;
  }
}

export async function captureWorktreeState(
  options: WorktreeStateOptions
): Promise<WorktreeStateCaptureResult> {
  // Created inside the try: an unusable temp directory has to degrade to a
  // skip like every other failure, because the caller awaits this before the
  // turn's outcome is emitted.
  let workspace: string | undefined;
  try {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-worktree-state-'));
    // The archive is written outside the staged tree so it can never become
    // one of its own entries.
    const stage = path.join(workspace, 'stage');
    const bundlePath = path.join(workspace, 'bundle.tar.gz');
    await fs.mkdir(stage, { recursive: true });
    const head = await headCommit(options);
    if (!head) return { status: 'skipped', reason: 'unreadable_head' };

    const patchPath = path.join(stage, WORKTREE_STATE_PATCH_ENTRY);
    try {
      await spawnToFile(
        'git',
        ['-C', options.directory, 'diff', 'HEAD', '--binary'],
        patchPath,
        options
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('byte ceiling')) {
        return { status: 'skipped', reason: 'too_large' };
      }
      return { status: 'skipped', reason: 'diff_failed' };
    }
    const patchBytes = (await fs.stat(patchPath)).size;
    if (patchBytes > MAX_STAGED_BYTES) return { status: 'skipped', reason: 'too_large' };
    if (patchBytes === 0) await fs.rm(patchPath, { force: true });

    const untracked = await untrackedPaths(options);
    if (!untracked) return { status: 'skipped', reason: 'untracked_listing_failed' };

    const copied: string[] = [];
    let staged = patchBytes;
    for (const relative of untracked) {
      // The copy loop is the one unabortable stretch of the capture, and it
      // runs before the turn's outcome is reported, so it honours the budget
      // itself rather than only at the subprocess boundaries.
      options.signal?.throwIfAborted();
      const source = path.resolve(options.directory, relative);
      if (!isContainedPath(options.directory, source)) continue;
      // `lstat`, not `stat`: an untracked symlink would otherwise be captured
      // as a copy of whatever it points at, including files outside the
      // worktree, and restored as a regular file.
      const stats = await fs.lstat(source).catch(() => undefined);
      if (!stats?.isFile()) continue;
      staged += stats.size;
      if (staged > MAX_STAGED_BYTES) return { status: 'skipped', reason: 'too_large' };
      // Checked before copying, not after: the bundle schema caps this list, so
      // without the guard the copies would all be paid for and then thrown away
      // when the metadata failed to parse — every turn, forever.
      if (copied.length >= WORKTREE_STATE_MAX_UNTRACKED_FILES) {
        return { status: 'skipped', reason: 'too_many_files' };
      }
      const destination = path.join(stage, WORKTREE_STATE_UNTRACKED_PREFIX, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      copied.push(relative);
    }

    const meta: WorktreeStateMeta = worktreeStateMetaSchema.parse({
      version: WORKTREE_STATE_BUNDLE_VERSION,
      head,
      capturedAt: Date.now(),
      hasPatch: patchBytes > 0,
      untracked: copied,
    });
    await fs.writeFile(path.join(stage, WORKTREE_STATE_META_ENTRY), JSON.stringify(meta));

    try {
      await spawnToFile(
        'tar',
        [
          'czf',
          '-',
          '-C',
          stage,
          WORKTREE_STATE_META_ENTRY,
          ...(patchBytes > 0 ? [WORKTREE_STATE_PATCH_ENTRY] : []),
          ...(copied.length > 0 ? [WORKTREE_STATE_UNTRACKED_PREFIX.replace(/\/$/, '')] : []),
        ],
        bundlePath,
        options
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('byte ceiling')) {
        return { status: 'skipped', reason: 'too_large' };
      }
      return { status: 'skipped', reason: 'archive_failed' };
    }
    const bundleBytes = (await fs.stat(bundlePath)).size;
    if (bundleBytes > WORKTREE_STATE_MAX_BYTES) return { status: 'skipped', reason: 'too_large' };

    const response = await fetch(options.endpoint.url, {
      method: 'PUT',
      // Content-Length is owned by the fetch layer, which derives it from the
      // buffered body; the route does not depend on it either.
      headers: {
        Authorization: `Bearer ${options.endpoint.grant}`,
        'Content-Type': 'application/gzip',
      },
      body: await fs.readFile(bundlePath),
      signal: AbortSignal.any(
        [options.signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)].filter(
          (value): value is AbortSignal => value !== undefined
        )
      ),
    });
    if (!response.ok) return { status: 'skipped', reason: `upload_${response.status}` };
    return { status: 'captured', bytes: bundleBytes, files: copied.length };
  } catch {
    return { status: 'skipped', reason: 'capture_failed' };
  } finally {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function restoreWorktreeState(
  options: WorktreeStateOptions
): Promise<WorktreeStateRestoreResult> {
  // Created inside the try for the same reason as the capture, and more
  // sharply: this runs inside session attachment, which must not fail because
  // a restore could not be attempted.
  let stage: string | undefined;
  try {
    stage = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-worktree-restore-'));
    const response = await fetch(options.endpoint.url, {
      headers: { Authorization: `Bearer ${options.endpoint.grant}` },
      signal: AbortSignal.any(
        [options.signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)].filter(
          (value): value is AbortSignal => value !== undefined
        )
      ),
    });
    if (response.status === 404) return { status: 'skipped', reason: 'absent' };
    if (!response.ok) return { status: 'skipped', reason: `download_${response.status}` };

    const bundlePath = path.join(stage, 'bundle.tar.gz');
    const bundle = Buffer.from(await response.arrayBuffer());
    if (bundle.byteLength > WORKTREE_STATE_MAX_BYTES) {
      return { status: 'skipped', reason: 'too_large' };
    }
    await fs.writeFile(bundlePath, bundle);

    const extracted = path.join(stage, 'bundle');
    await fs.mkdir(extracted, { recursive: true });
    const tarPath = path.join(stage, 'bundle.tar');
    try {
      await gunzipBounded(bundlePath, tarPath, MAX_STAGED_BYTES);
    } catch {
      return { status: 'skipped', reason: 'too_large' };
    }
    try {
      await spawnToFile('tar', ['xf', tarPath, '-C', extracted], path.join(stage, 'tar.log'), {
        ...options,
        directory: stage,
      });
    } catch {
      return { status: 'skipped', reason: 'extract_failed' };
    }

    const parsed = worktreeStateMetaSchema.safeParse(
      JSON.parse(await fs.readFile(path.join(extracted, WORKTREE_STATE_META_ENTRY), 'utf8'))
    );
    if (!parsed.success) return { status: 'skipped', reason: 'invalid_meta' };
    const meta = parsed.data;

    // A patch produced against a different commit can only be applied by
    // guessing; leaving the freshly prepared worktree untouched is safer than
    // half-applying someone's work.
    const head = await headCommit(options);
    if (!head) return { status: 'skipped', reason: 'unreadable_head' };
    if (head !== meta.head) return { status: 'skipped', reason: 'head_mismatch' };

    if (meta.hasPatch) {
      const patchPath = path.join(extracted, WORKTREE_STATE_PATCH_ENTRY);
      // Plain `git apply` is all-or-nothing: it refuses the whole patch unless
      // every hunk applies, so a failure leaves the prepared worktree exactly
      // as the rebuild left it. `--3way` is deliberately not used as a
      // fallback — it half-applies, writes conflict markers and leaves
      // unmerged index entries, which the agent would then start working in
      // and the next auto-commit would commit. With HEAD already proven equal,
      // the only patches it could rescue are ones a setup command conflicts
      // with, which is precisely the case that must be skipped.
      const applied = await runGit(['apply', '--whitespace=nowarn', patchPath], options);
      if (applied.exitCode !== 0) return { status: 'skipped', reason: 'patch_failed' };
    }

    const worktreeRoot = await fs.realpath(options.directory);
    let restoredFiles = 0;
    for (const relative of meta.untracked) {
      options.signal?.throwIfAborted();
      try {
        const destination = path.resolve(options.directory, relative);
        if (!isContainedPath(options.directory, destination)) continue;
        const source = path.join(extracted, WORKTREE_STATE_UNTRACKED_PREFIX, relative);
        if (!isContainedPath(extracted, source)) continue;
        // Never clobber a file the rebuild produced; the captured copy is only
        // meant to fill in what the fresh worktree is missing.
        if (
          await fs.lstat(destination).then(
            () => true,
            () => false
          )
        )
          continue;
        if (
          !(await fs.lstat(source).then(
            stats => stats.isFile(),
            () => false
          ))
        )
          continue;
        const parent = await writableParent(worktreeRoot, destination);
        if (!parent) continue;
        await fs.mkdir(parent, { recursive: true });
        await fs.copyFile(source, destination);
        restoredFiles += 1;
      } catch {
        continue;
      }
    }
    return { status: 'restored', files: restoredFiles };
  } catch {
    return { status: 'skipped', reason: 'restore_failed' };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Drops a worktree's stored bundle. Called when the worktree itself is deleted,
 * so uncommitted work does not outlive it in object storage.
 */
export async function discardWorktreeState(
  endpoint: WorktreeStateEndpoint,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetch(endpoint.url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${endpoint.grant}` },
      // Worktree deletion waits on this, so it gets a much shorter leash than a
      // capture: a bundle left behind expires on its own TTL anyway.
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(DISCARD_TIMEOUT_MS)].filter(
          (value): value is AbortSignal => value !== undefined
        )
      ),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function logWorktreeState(
  operation: 'capture' | 'restore',
  directory: string,
  result: WorktreeStateCaptureResult | WorktreeStateRestoreResult
): void {
  const detail =
    result.status === 'skipped'
      ? `skipped reason=${result.reason}`
      : 'files' in result && 'bytes' in result
        ? `captured bytes=${result.bytes} files=${result.files}`
        : `restored files=${'files' in result ? result.files : 0}`;
  logToFile(`worktree-state: ${operation} directory=${directory} ${detail}`);
}
