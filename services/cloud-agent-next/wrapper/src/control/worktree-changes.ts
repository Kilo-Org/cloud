import { constants, type Stats } from 'fs';
import { lstat, open, readlink, realpath } from 'fs/promises';
import { dirname, join } from 'path';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  sessionGitSummaryPayloadSchema,
  sessionGitSummaryResultSchema,
  worktreeChangesFileSchema,
  type SessionGitSummaryPayload,
  type SessionGitSummaryResult,
  type WorktreeChangesFile,
} from '../../../src/shared/sandbox-control-protocol.js';
import { git, withTimeoutAndAbort } from '../utils.js';

const CAPTURE_TIMEOUT_MS = 20_000;
const MAX_RAW_OUTPUT_BYTES = 512 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 1_000_000;
const MAX_UNTRACKED_READ_BYTES = 16 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;
const SUMMARY_BYTES = MAX_WORKTREE_CHANGES_BYTES - 1024;
const CAPTURE_FAILED = 'Worktree capture failed';
const DEFAULT_BASE_REF = 'refs/remotes/origin/HEAD';
const RAW_HEADER =
  /^:([0-7]{6}) ([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([AMDTU])$/;

function nulRecords(output: string): string[] {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new Error(CAPTURE_FAILED);
  return output.slice(0, -1).split('\0');
}

function parsePath(value: string | undefined): string {
  const parsed = worktreeChangesFileSchema.shape.path.safeParse(value);
  if (!parsed.success) throw new Error(CAPTURE_FAILED);
  return parsed.data;
}

function parseCount(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(CAPTURE_FAILED);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(CAPTURE_FAILED);
  return count;
}

export function parseWorktreeDiff(output: string): WorktreeChangesFile[] {
  const records = nulRecords(output);
  const statuses = new Map<string, WorktreeChangesFile['status']>();
  const possiblyUnchanged = new Set<string>();
  let index = 0;
  while (records[index]?.startsWith(':')) {
    const header = RAW_HEADER.exec(records[index]);
    if (!header || header[3] === 'U') throw new Error(CAPTURE_FAILED);
    const path = parsePath(records[index + 1]);
    if (statuses.has(path)) throw new Error(CAPTURE_FAILED);
    statuses.set(path, header[3] === 'A' ? 'added' : header[3] === 'D' ? 'deleted' : 'modified');
    if (header[3] === 'M' && header[1] === header[2]) possiblyUnchanged.add(path);
    index += 2;
  }

  const files = new Map<string, WorktreeChangesFile>();
  for (; index < records.length; index += 1) {
    const record = records[index];
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) throw new Error(CAPTURE_FAILED);
    const path = parsePath(record.slice(secondTab + 1));
    const status = statuses.get(path);
    if (!status || files.has(path)) throw new Error(CAPTURE_FAILED);
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const binary = added === '-' && deleted === '-';
    files.set(path, {
      path,
      status,
      additions: binary ? 0 : parseCount(added),
      deletions: binary ? 0 : parseCount(deleted),
      tracked: true,
      binary,
      countsComplete: !binary,
    });
  }
  const result: WorktreeChangesFile[] = [];
  for (const path of statuses.keys()) {
    const file = files.get(path);
    if (file) result.push(file);
    else if (!possiblyUnchanged.has(path)) throw new Error(CAPTURE_FAILED);
  }
  return result;
}

function isBinary(bytes: Uint8Array): boolean {
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return bytes.length > 0 && controls / bytes.length > 0.3;
}

function lineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 10) lines += 1;
  }
  return lines + (bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? 1 : 0);
}

function sameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readUntracked(
  directory: string,
  path: string,
  budget: { remaining: number },
  reservedSampleBytes: number,
  checkDeadline: () => number
): Promise<WorktreeChangesFile> {
  checkDeadline();
  const fullPath = join(directory, path);
  if ((await realpath(dirname(fullPath))) !== dirname(fullPath)) throw new Error(CAPTURE_FAILED);
  const before = await lstat(fullPath);
  const file: WorktreeChangesFile = {
    path,
    status: 'added',
    additions: 0,
    deletions: 0,
    tracked: false,
    binary: false,
    countsComplete: false,
  };

  if (before.isSymbolicLink()) {
    const target = await readlink(fullPath, { encoding: 'buffer' });
    budget.remaining -= target.length;
    if (budget.remaining < 0 || !sameFile(before, await lstat(fullPath))) {
      throw new Error(CAPTURE_FAILED);
    }
    checkDeadline();
    return { ...file, additions: lineCount(target), countsComplete: true };
  }
  if (!before.isFile()) throw new Error(CAPTURE_FAILED);

  const handle = await open(
    fullPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!sameFile(before, await handle.stat())) throw new Error(CAPTURE_FAILED);
    const sampleBytes = Math.min(before.size, BINARY_SAMPLE_BYTES);
    const complete =
      before.size <= MAX_UNTRACKED_FILE_BYTES &&
      before.size <= budget.remaining - reservedSampleBytes;
    const bytes = Buffer.alloc(complete ? before.size : sampleBytes);

    async function readUntil(start: number, end: number): Promise<void> {
      let offset = start;
      while (offset < end) {
        checkDeadline();
        if (end - offset > budget.remaining) throw new Error(CAPTURE_FAILED);
        const { bytesRead } = await handle.read(bytes, offset, end - offset, offset);
        if (bytesRead === 0) throw new Error(CAPTURE_FAILED);
        budget.remaining -= bytesRead;
        offset += bytesRead;
      }
    }

    await readUntil(0, sampleBytes);
    file.binary = isBinary(bytes.subarray(0, sampleBytes));
    if (!file.binary && complete) {
      await readUntil(sampleBytes, bytes.length);
      file.additions = lineCount(bytes);
      file.countsComplete = true;
    }
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(fullPath))) {
      throw new Error(CAPTURE_FAILED);
    }
    checkDeadline();
    return file;
  } finally {
    await handle.close();
  }
}

export async function collectWorktreeChanges(
  directory: string,
  request: SessionGitSummaryPayload,
  runGit: typeof git = git,
  signal?: AbortSignal
): Promise<SessionGitSummaryResult> {
  const controller = new AbortController();
  const captureSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;

  function remainingTime(): number {
    const remaining = deadline - Date.now();
    if (captureSignal.aborted || remaining <= 0) throw new Error(CAPTURE_FAILED);
    return remaining;
  }

  async function capture(): Promise<SessionGitSummaryResult> {
    remainingTime();
    const payload = sessionGitSummaryPayloadSchema.parse(request);
    const root = await realpath(directory);
    async function command(args: string[]): Promise<string> {
      const result = await runGit(
        [
          '--no-pager',
          '--no-optional-locks',
          '-c',
          'color.ui=false',
          '-c',
          'core.quotepath=false',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'diff.autoRefreshIndex=false',
          ...args,
        ],
        {
          cwd: root,
          inheritEnv: false,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
          },
          timeoutMs: remainingTime(),
          terminationGraceMs: 250,
          maxOutputBytes: MAX_RAW_OUTPUT_BYTES,
          signal: captureSignal,
        }
      );
      remainingTime();
      if (
        result.exitCode !== 0 ||
        result.terminationReason !== undefined ||
        result.stdoutTruncated ||
        result.stderrTruncated
      ) {
        throw new Error(CAPTURE_FAILED);
      }
      return result.stdout;
    }

    async function resolveCommit(ref: string): Promise<string> {
      const output = await command([
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${ref}^{commit}`,
      ]);
      const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(output)
        ? output.slice(0, -1)
        : undefined;
      if (!commit) throw new Error(CAPTURE_FAILED);
      return commit;
    }

    async function resolveDefaultBase(): Promise<string> {
      const output = await command(['symbolic-ref', '--quiet', DEFAULT_BASE_REF]);
      if (!output.endsWith('\n') || output.slice(0, -1).includes('\n')) {
        throw new Error(CAPTURE_FAILED);
      }
      const base = output.slice(0, -1);
      if (!base.startsWith('refs/remotes/origin/')) throw new Error(CAPTURE_FAILED);
      return base;
    }

    if ((await command(['rev-parse', '--show-prefix'])) !== '\n') throw new Error(CAPTURE_FAILED);
    const baseRef = payload.baseRef ?? (await resolveDefaultBase());
    await command(['check-ref-format', '--allow-onelevel', baseRef]);
    const head = await resolveCommit('HEAD');
    const base = await resolveCommit(baseRef);
    const mergeBaseOutput = await command(['merge-base', head, base]);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(mergeBaseOutput)) {
      throw new Error(CAPTURE_FAILED);
    }
    const mergeBase = mergeBaseOutput.slice(0, -1);
    const tracked = parseWorktreeDiff(
      await command([
        'diff',
        '--raw',
        '--numstat',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=none',
        '--abbrev=64',
        '-z',
        mergeBase,
        '--',
      ])
    );
    const untrackedPaths = nulRecords(
      await command(['ls-files', '--others', '--exclude-standard', '-z'])
    ).map(parsePath);
    if (new Set(untrackedPaths).size !== untrackedPaths.length) throw new Error(CAPTURE_FAILED);
    const trackedPaths = new Set(tracked.map(file => file.path));
    const untracked = untrackedPaths.filter(
      path => path !== '.kilo-bootstrap-complete' && !trackedPaths.has(path)
    );

    const result: SessionGitSummaryResult = {
      revision: payload.revision,
      comparison: { baseRef, mergeBase, head },
      files: [],
      truncated: false,
    };
    let bytes = Buffer.byteLength(JSON.stringify(result));
    function append(file: WorktreeChangesFile): boolean {
      const addedBytes =
        Buffer.byteLength(JSON.stringify(file)) + (result.files.length > 0 ? 1 : 0);
      if (result.files.length >= MAX_WORKTREE_CHANGES_FILES || bytes + addedBytes > SUMMARY_BYTES) {
        result.truncated = true;
        return false;
      }
      result.files.push(file);
      bytes += addedBytes;
      return true;
    }

    for (const file of tracked) {
      if (!append(file)) break;
    }
    const budget = { remaining: MAX_UNTRACKED_READ_BYTES };
    if (!result.truncated) {
      for (let index = 0; index < untracked.length; index += 1) {
        if (result.files.length >= MAX_WORKTREE_CHANGES_FILES) {
          result.truncated = true;
          break;
        }
        const remainingFiles = Math.min(
          untracked.length - index - 1,
          MAX_WORKTREE_CHANGES_FILES - result.files.length - 1
        );
        const file = await readUntracked(
          root,
          untracked[index],
          budget,
          remainingFiles * BINARY_SAMPLE_BYTES,
          remainingTime
        );
        if (!append(file)) break;
      }
    }

    if (
      (await resolveCommit('HEAD')) !== head ||
      (await resolveCommit(baseRef)) !== base ||
      (payload.baseRef === undefined && (await resolveDefaultBase()) !== baseRef)
    ) {
      throw new Error(CAPTURE_FAILED);
    }
    remainingTime();
    return sessionGitSummaryResultSchema.parse(result);
  }

  try {
    return await withTimeoutAndAbort(capture(), {
      timeoutMs: CAPTURE_TIMEOUT_MS,
      timeoutMessage: CAPTURE_FAILED,
      signal: captureSignal,
      abortMessage: CAPTURE_FAILED,
    });
  } finally {
    controller.abort();
  }
}
