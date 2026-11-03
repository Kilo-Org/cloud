import { constants } from 'fs';
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
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
import {
  MAX_WORKTREE_CONTENT_BYTES,
  MAX_WORKTREE_CONTENT_LINES,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_PATCH_LINES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  WORKTREE_FILE_SCHEMA_VERSION,
  sessionGitSnapshotResultSchema,
  worktreeFileIdentity,
  worktreeRecoverySchema,
  type SessionGitSnapshotPayload,
  type SessionGitSnapshotResult,
  type WorktreeFileRecord,
  type WorktreeRecovery,
} from '../../../src/shared/worktree-changes-wire.js';
import { git, withTimeoutAndAbort } from '../utils.js';
import {
  WorktreeFileCaptureError,
  decodeWorktreeUtf8,
  fileOmissionReason,
  inspectWorktreeFile,
  isBinary,
  lineCount,
  readWorktreeFile,
  sameFile,
  verifyWorktreeFile,
  withStableWorktreeFile,
  type FileOmissionReason,
  type WorktreeFileState,
} from './worktree-file-capture.js';

const CAPTURE_TIMEOUT_MS = 20_000;
const FINAL_CHECK_RESERVE_MS = 2_000;
const FILE_COMMAND_TIMEOUT_MS = 2_000;
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

type FileModes = { before: string; after: string };
type CapturedUntrackedFile = { bytes: Buffer; state: WorktreeFileState };
type SnapshotGit = (
  args: string[],
  options?: {
    cwd?: string;
    stdinFd?: number;
    maxOutputBytes?: number;
    allowDifferences?: boolean;
    rawInput?: boolean;
  }
) => Promise<Buffer>;

export function parseWorktreeDiff(
  output: string,
  modes?: Map<string, FileModes>
): WorktreeChangesFile[] {
  const records = nulRecords(output);
  const statuses = new Map<string, WorktreeChangesFile['status']>();
  const possiblyUnchanged = new Set<string>();
  let index = 0;
  while (records[index]?.startsWith(':')) {
    const header = RAW_HEADER.exec(records[index]);
    if (!header || header[3] === 'U') throw new Error(CAPTURE_FAILED);
    const path = parsePath(records[index + 1]);
    if (statuses.has(path)) throw new Error(CAPTURE_FAILED);
    modes?.set(path, { before: header[1], after: header[2] });
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

async function readUntracked(
  directory: string,
  path: string,
  budget: { remaining: number },
  reservedSampleBytes: number,
  checkDeadline: () => number,
  captured?: Map<string, CapturedUntrackedFile>
): Promise<WorktreeChangesFile> {
  checkDeadline();
  const fullPath = join(directory, path);
  if ((await realpath(dirname(fullPath))) !== dirname(fullPath)) {
    throw new WorktreeFileCaptureError('unsupported');
  }
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
  if (!before.isFile()) throw new WorktreeFileCaptureError('unsupported');
  const state = captured ? await inspectWorktreeFile(directory, path) : undefined;

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
    if (state) {
      await verifyWorktreeFile(state);
      if (complete && !file.binary && bytes.length <= MAX_WORKTREE_FILE_BYTES) {
        captured?.set(path, { bytes, state });
      }
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
  return (await collectWorktree(directory, request, runGit, false, signal)).summary;
}

export async function collectWorktreeSnapshot(
  directory: string,
  request: SessionGitSnapshotPayload,
  runGit: typeof git = git,
  signal?: AbortSignal
): Promise<SessionGitSnapshotResult> {
  return collectWorktree(directory, request, runGit, true, signal);
}

async function collectWorktree(
  directory: string,
  request: SessionGitSummaryPayload,
  runGit: typeof git,
  includeFiles: boolean,
  signal?: AbortSignal
): Promise<SessionGitSnapshotResult> {
  const controller = new AbortController();
  const captureSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  let temporaryDirectory: string | undefined;

  function remainingTime(): number {
    const remaining = deadline - Date.now();
    if (captureSignal.aborted || remaining <= 0) throw new Error(CAPTURE_FAILED);
    return remaining;
  }

  function remainingFileTime(): number {
    const remaining = deadline - Date.now() - FINAL_CHECK_RESERVE_MS;
    if (captureSignal.aborted || remaining <= 0) {
      throw new WorktreeFileCaptureError('budget_exhausted');
    }
    return remaining;
  }

  async function capture(): Promise<SessionGitSnapshotResult> {
    remainingTime();
    const payload = sessionGitSummaryPayloadSchema.parse(request);
    const root = await realpath(directory);
    async function execute(
      args: string[],
      options: {
        cwd?: string;
        stdinFd?: number;
        maxOutputBytes?: number;
        allowDifferences?: boolean;
        rawInput?: boolean;
        file?: boolean;
      } = {}
    ) {
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
          '-c',
          'diff.suppressBlankEmpty=false',
          ...(options.rawInput
            ? ['-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null']
            : []),
          ...args,
        ],
        {
          cwd: options.cwd ?? root,
          stdinFd: options.stdinFd,
          inheritEnv: false,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_LITERAL_PATHSPECS: '1',
            GIT_GLOB_PATHSPECS: undefined,
            GIT_NOGLOB_PATHSPECS: undefined,
            GIT_ICASE_PATHSPECS: undefined,
            ...(options.rawInput ? { GIT_ATTR_NOSYSTEM: '1', GIT_ATTR_SOURCE: undefined } : {}),
          },
          timeoutMs: options.file
            ? Math.min(remainingFileTime(), FILE_COMMAND_TIMEOUT_MS)
            : remainingTime(),
          terminationGraceMs: 250,
          maxOutputBytes: options.maxOutputBytes ?? MAX_RAW_OUTPUT_BYTES,
          rawOutput: includeFiles,
          signal: captureSignal,
        }
      );
      if (options.file) remainingFileTime();
      else remainingTime();
      if (result.stdoutTruncated) throw new WorktreeFileCaptureError('too_large');
      if (
        (result.exitCode !== 0 && !(options.allowDifferences && result.exitCode === 1)) ||
        result.terminationReason !== undefined ||
        result.stderrTruncated
      ) {
        throw new Error(CAPTURE_FAILED);
      }
      return result;
    }

    async function command(args: string[]): Promise<string> {
      const result = await execute(args);
      if (!includeFiles) return result.stdout;
      if (!result.stdoutBytes) throw new Error(CAPTURE_FAILED);
      return decodeWorktreeUtf8(result.stdoutBytes);
    }

    const snapshotGit: SnapshotGit = async (args, options) => {
      const result = await execute(args, { ...options, file: true });
      if (!result.stdoutBytes) throw new Error(CAPTURE_FAILED);
      return result.stdoutBytes;
    };

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
    const modes = new Map<string, FileModes>();
    async function trackedChanges(
      scope: WorktreeChangesFile['scope'],
      refs: string[]
    ): Promise<WorktreeChangesFile[]> {
      const scopedModes = new Map<string, FileModes>();
      const files = parseWorktreeDiff(
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
          ...refs,
          '--',
        ]),
        scopedModes
      ).map(file => (scope === undefined ? file : { ...file, scope }));
      for (const file of files) {
        const mode = scopedModes.get(file.path);
        if (mode) modes.set(worktreeFileIdentity(file), mode);
      }
      return files;
    }
    const uncommitted = await trackedChanges('uncommitted', [head]);
    const committed = await trackedChanges('against-base-branch', [mergeBase, head]);
    const combined = includeFiles ? await trackedChanges(undefined, [mergeBase]) : [];
    const tracked = [...uncommitted, ...committed];
    const untrackedPaths = nulRecords(
      await command(['ls-files', '--others', '--exclude-standard', '-z'])
    ).map(parsePath);
    if (new Set(untrackedPaths).size !== untrackedPaths.length) throw new Error(CAPTURE_FAILED);
    const trackedPaths = new Set(uncommitted.map(file => file.path));
    const untracked = untrackedPaths.filter(
      path => path !== '.kilo-bootstrap-complete' && !trackedPaths.has(path)
    );
    const untrackedSet = new Set(untracked);
    for (const file of combined) {
      if (file.status === 'deleted' && untrackedSet.has(file.path)) {
        file.status = 'modified';
        file.tracked = false;
        file.countsComplete = false;
      }
    }

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
    if (includeFiles) temporaryDirectory = await mkdtemp(join(tmpdir(), 'worktree-patch-'));
    const budget = { remaining: MAX_UNTRACKED_READ_BYTES };
    const capturedUntracked = new Map<string, CapturedUntrackedFile>();
    const failedFiles = new Map<string, FileOmissionReason>();
    const combinedPaths = new Set(combined.map(file => file.path));
    const recoveryUntracked: WorktreeChangesFile[] = [];
    const recoverySlots = Math.max(0, MAX_WORKTREE_CHANGES_FILES - combined.length);
    if (!result.truncated || includeFiles) {
      for (let index = 0; index < untracked.length; index += 1) {
        if (result.files.length >= MAX_WORKTREE_CHANGES_FILES) {
          result.truncated = true;
        }
        if (result.truncated && (!includeFiles || recoveryUntracked.length >= recoverySlots)) break;
        const remainingFiles = Math.min(
          untracked.length - index - 1,
          Math.max(
            MAX_WORKTREE_CHANGES_FILES - result.files.length - 1,
            includeFiles ? recoverySlots - recoveryUntracked.length - 1 : 0
          )
        );
        const path = untracked[index];
        let file: WorktreeChangesFile;
        try {
          file = await readUntracked(
            root,
            path,
            budget,
            remainingFiles * BINARY_SAMPLE_BYTES,
            includeFiles ? remainingFileTime : remainingTime,
            includeFiles ? capturedUntracked : undefined
          );
        } catch (error) {
          if (!includeFiles) throw error;
          failedFiles.set(path, fileOmissionReason(error));
          file = {
            path,
            status: 'added',
            additions: 0,
            deletions: 0,
            tracked: false,
            binary: false,
            countsComplete: false,
          };
        }
        if (
          includeFiles &&
          recoveryUntracked.length < recoverySlots &&
          !combinedPaths.has(file.path)
        ) {
          recoveryUntracked.push(file);
        }
        if (!result.truncated && !append({ ...file, scope: 'uncommitted' }) && !includeFiles) break;
      }
    }

    const summary = sessionGitSummaryResultSchema.parse(result);
    const files = temporaryDirectory
      ? await collectSnapshotFiles({
          root,
          temporaryDirectory,
          summary,
          modes,
          capturedUntracked: new Map(capturedUntracked),
          failedFiles,
          runGit: snapshotGit,
          remainingTime: remainingFileTime,
          reservedBytes: MAX_WORKTREE_CHANGES_BYTES + Buffer.byteLength(',"recovery":'),
        })
      : [];
    let recovery: WorktreeRecovery | undefined;
    if (temporaryDirectory) {
      const candidates = [...combined, ...recoveryUntracked];
      const recoverySummary: SessionGitSummaryResult = { ...summary, files: [], truncated: false };
      let recoverySummaryBytes = encodedBytes(recoverySummary);
      for (const file of candidates) {
        const extra = encodedBytes(file) + (recoverySummary.files.length > 0 ? 1 : 0);
        if (
          recoverySummary.files.length >= MAX_WORKTREE_CHANGES_FILES ||
          recoverySummaryBytes + extra > SUMMARY_BYTES
        ) {
          recoverySummary.truncated = true;
          break;
        }
        recoverySummary.files.push(file);
        recoverySummaryBytes += extra;
      }
      const recoveryRecords = await collectSnapshotFiles({
        root,
        temporaryDirectory,
        summary: recoverySummary,
        modes,
        capturedUntracked: new Map(capturedUntracked),
        failedFiles,
        runGit: snapshotGit,
        remainingTime: remainingFileTime,
        captureContent: false,
      });
      const recoveryFiles: WorktreeRecovery['files'] = recoverySummary.files.map(file => ({
        path: file.path,
        status: file.status,
      }));
      let remaining = MAX_WORKTREE_CHANGES_BYTES - encodedBytes({ files: recoveryFiles });
      for (const [index, record] of recoveryRecords.entries()) {
        if (record.diff.status !== 'available') continue;
        const file = recoveryFiles[index];
        const extra = encodedBytes({ ...file, patch: record.diff.patch }) - encodedBytes(file);
        if (extra <= remaining) {
          file.patch = record.diff.patch;
          remaining -= extra;
        }
      }
      recovery = worktreeRecoverySchema.parse({ files: recoveryFiles });
    }
    if (
      (await resolveCommit('HEAD')) !== head ||
      (await resolveCommit(baseRef)) !== base ||
      (payload.baseRef === undefined && (await resolveDefaultBase()) !== baseRef)
    ) {
      throw new Error(CAPTURE_FAILED);
    }
    remainingTime();
    const snapshot = { summary, files, ...(recovery === undefined ? {} : { recovery }) };
    return includeFiles ? sessionGitSnapshotResultSchema.parse(snapshot) : snapshot;
  }

  try {
    return await withTimeoutAndAbort(
      capture().finally(async () => {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      }),
      {
        timeoutMs: CAPTURE_TIMEOUT_MS,
        timeoutMessage: CAPTURE_FAILED,
        signal: captureSignal,
        abortMessage: CAPTURE_FAILED,
      }
    );
  } finally {
    controller.abort();
  }
}

const PATCH_ARGUMENTS = [
  'diff',
  '--patch',
  '--unified=10',
  '--inter-hunk-context=0',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=none',
];

const COMMON_LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
]);

async function generatedPaths(files: WorktreeChangesFile[], runGit: SnapshotGit) {
  const generated = new Set(
    files.filter(file => COMMON_LOCKFILES.has(basename(file.path))).map(file => file.path)
  );
  let index = 0;
  while (index < files.length) {
    const paths: string[] = [];
    let bytes = 0;
    while (index < files.length && bytes < 32 * 1024) {
      const path = files[index++].path;
      paths.push(path);
      bytes += Buffer.byteLength(path) + 1;
    }
    try {
      const output = nulRecords(
        decodeWorktreeUtf8(await runGit(['check-attr', '-z', 'linguist-generated', '--', ...paths]))
      );
      if (output.length !== paths.length * 3) throw new Error(CAPTURE_FAILED);
      for (let offset = 0; offset < output.length; offset += 3) {
        const [path, attribute, value] = output.slice(offset, offset + 3);
        if (path !== paths[offset / 3] || attribute !== 'linguist-generated') {
          throw new Error(CAPTURE_FAILED);
        }
        if (value === 'set' || value === 'true') generated.add(path);
      }
    } catch {
      break;
    }
  }
  return generated;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function omittedRecord(
  revision: number,
  file: Pick<WorktreeChangesFile, 'path' | 'scope'>,
  reason: FileOmissionReason
): WorktreeFileRecord {
  return {
    schemaVersion: WORKTREE_FILE_SCHEMA_VERSION,
    revision,
    path: file.path,
    scope: file.scope,
    diff: { status: 'omitted', reason },
    content: { status: 'unavailable', reason },
  };
}

async function collectSnapshotFiles({
  root,
  temporaryDirectory,
  summary,
  modes,
  capturedUntracked,
  failedFiles,
  runGit,
  remainingTime,
  captureContent = true,
  reservedBytes = 0,
}: {
  root: string;
  temporaryDirectory: string;
  summary: SessionGitSummaryResult;
  modes: Map<string, FileModes>;
  capturedUntracked: Map<string, CapturedUntrackedFile>;
  failedFiles: Map<string, FileOmissionReason>;
  runGit: SnapshotGit;
  remainingTime: () => number;
  captureContent?: boolean;
  reservedBytes?: number;
}): Promise<WorktreeFileRecord[]> {
  const records = summary.files.map(file =>
    omittedRecord(summary.revision, file, 'budget_exhausted')
  );
  let totalBytes = encodedBytes({ summary, files: records }) + reservedBytes;
  const indices = new Map(records.map((record, index) => [worktreeFileIdentity(record), index]));
  const contentInputs = new Map<string, { state?: WorktreeFileState; bytes?: Buffer }>();

  function replace(record: WorktreeFileRecord): FileOmissionReason | undefined {
    const index = indices.get(worktreeFileIdentity(record));
    if (index === undefined) throw new Error(CAPTURE_FAILED);
    const bytes = encodedBytes(record);
    if (bytes > MAX_WORKTREE_FILE_BYTES) return 'too_large';
    const nextBytes = totalBytes - encodedBytes(records[index]) + bytes;
    if (nextBytes > MAX_WORKTREE_SNAPSHOT_BYTES) return 'budget_exhausted';
    records[index] = record;
    totalBytes = nextBytes;
    return undefined;
  }

  async function readBlob(ref: string, path: string, maxBytes: number): Promise<Buffer> {
    const blob = `${ref}:${path}`;
    const sizeOutput = decodeWorktreeUtf8(await runGit(['cat-file', '-s', blob]));
    if (!sizeOutput.endsWith('\n')) throw new Error(CAPTURE_FAILED);
    const size = parseCount(sizeOutput.slice(0, -1));
    if (size > maxBytes) throw new WorktreeFileCaptureError('too_large');
    const bytes = await runGit(['cat-file', 'blob', blob], { maxOutputBytes: maxBytes });
    if (bytes.length !== size) throw new WorktreeFileCaptureError('inconsistent');
    return bytes;
  }

  async function patchFromBytes(
    path: string,
    bytes: Buffer,
    mode: number | undefined,
    deleted: boolean,
    original?: { bytes: Buffer; mode: number }
  ): Promise<Buffer> {
    const directory = await mkdtemp(join(temporaryDirectory, 'file-'));
    try {
      const temporaryPath = original ? join(directory, 'b', path) : join(directory, path);
      await mkdir(dirname(temporaryPath), { recursive: true });
      await writeFile(temporaryPath, bytes, { mode });
      if (original) {
        const originalPath = join(directory, 'a', path);
        await mkdir(dirname(originalPath), { recursive: true });
        await writeFile(originalPath, original.bytes, { mode: original.mode });
      }
      const operand = path === '-' ? './-' : path;
      return await runGit(
        [
          ...PATCH_ARGUMENTS,
          ...(original ? ['--no-prefix'] : []),
          '--no-index',
          '--',
          ...(original
            ? [`a/${path}`, `b/${path}`]
            : deleted
              ? [operand, '/dev/null']
              : ['/dev/null', operand]),
        ],
        {
          cwd: directory,
          maxOutputBytes: MAX_WORKTREE_FILE_BYTES,
          allowDifferences: true,
          rawInput: true,
        }
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const generated = await generatedPaths(summary.files, runGit);
  const ordered = [...summary.files].sort(
    (left, right) =>
      Number(generated.has(left.path)) - Number(generated.has(right.path)) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );

  for (const file of ordered) {
    const identity = worktreeFileIdentity(file);
    const committed = file.scope === 'against-base-branch';
    const beforeRef =
      file.scope === 'uncommitted' ? summary.comparison.head : summary.comparison.mergeBase;
    try {
      const failed = committed ? undefined : failedFiles.get(file.path);
      if (failed) throw new WorktreeFileCaptureError(failed);
      const mode = modes.get(identity);
      if (
        file.tracked &&
        (!mode ||
          !['000000', '100644', '100755'].includes(mode.before) ||
          !['000000', '100644', '100755'].includes(mode.after))
      ) {
        throw new WorktreeFileCaptureError('unsupported');
      }
      if (file.binary) throw new WorktreeFileCaptureError('binary');
      remainingTime();
      const cached = committed ? undefined : capturedUntracked.get(file.path);
      const state = committed
        ? undefined
        : (cached?.state ??
          (await inspectWorktreeFile(root, file.path, file.status === 'deleted')));
      if (state) await verifyWorktreeFile(state);
      const input = { state, bytes: cached?.bytes };
      contentInputs.set(identity, input);
      let patchBytes: Buffer;
      if (file.tracked && (committed || file.status !== 'deleted')) {
        const output = await runGit(
          [
            ...PATCH_ARGUMENTS,
            '--diff-filter=AMD',
            '--raw',
            '--numstat',
            '--abbrev=64',
            '-z',
            beforeRef,
            ...(committed ? [summary.comparison.head] : []),
            '--',
            file.path,
          ],
          { maxOutputBytes: MAX_WORKTREE_FILE_BYTES + 64 * 1024 }
        );
        const separator = output.indexOf('\0\0');
        if (separator < 0) throw new WorktreeFileCaptureError('inconsistent');
        const currentModes = new Map<string, FileModes>();
        const current = parseWorktreeDiff(
          decodeWorktreeUtf8(output.subarray(0, separator + 1)),
          currentModes
        );
        const currentFile = current[0];
        const currentMode = currentModes.get(file.path);
        if (
          current.length !== 1 ||
          !currentFile ||
          currentFile.path !== file.path ||
          currentFile.status !== file.status ||
          currentFile.additions !== file.additions ||
          currentFile.deletions !== file.deletions ||
          currentFile.binary !== file.binary ||
          currentMode?.before !== mode?.before ||
          currentMode?.after !== mode?.after
        ) {
          throw new WorktreeFileCaptureError('inconsistent');
        }
        patchBytes = output.subarray(separator + 2);
      } else {
        const deleted = file.status === 'deleted';
        const recreated = file.scope === undefined && !file.tracked && file.status === 'modified';
        if (recreated && (!mode || !['100644', '100755'].includes(mode.before))) {
          throw new WorktreeFileCaptureError('unsupported');
        }
        if (!state) throw new Error(CAPTURE_FAILED);
        const bytes = deleted
          ? await readBlob(beforeRef, file.path, MAX_WORKTREE_FILE_BYTES)
          : (cached?.bytes ??
            (await readWorktreeFile(state, MAX_WORKTREE_FILE_BYTES, remainingTime)));
        input.bytes = bytes;
        if (isBinary(bytes)) throw new WorktreeFileCaptureError('binary');
        decodeWorktreeUtf8(bytes);
        if (
          file.countsComplete &&
          lineCount(bytes) !== (deleted ? file.deletions : file.additions)
        ) {
          throw new WorktreeFileCaptureError('inconsistent');
        }
        const original = recreated
          ? {
              bytes: await readBlob(beforeRef, file.path, MAX_WORKTREE_FILE_BYTES),
              mode: mode?.before === '100755' ? 0o755 : 0o644,
            }
          : undefined;
        if (original) {
          if (isBinary(original.bytes)) throw new WorktreeFileCaptureError('binary');
          decodeWorktreeUtf8(original.bytes);
        }
        patchBytes = await patchFromBytes(
          file.path,
          bytes,
          deleted ? (mode?.before === '100755' ? 0o755 : 0o644) : state?.stat?.mode,
          deleted,
          original
        );
      }
      if (state) await verifyWorktreeFile(state);
      remainingTime();
      if (isBinary(patchBytes)) throw new WorktreeFileCaptureError('binary');
      let patch = decodeWorktreeUtf8(patchBytes);
      if (file.path === '-' && patch.startsWith('diff --git a/./- b/./-\n')) {
        patch = patch
          .replace('diff --git a/./- b/./-\n', 'diff --git a/- b/-\n')
          .replace('\n--- /dev/null\n+++ b/./-\n', '\n--- /dev/null\n+++ b/-\n')
          .replace('\n--- a/./-\n+++ /dev/null\n', '\n--- a/-\n+++ /dev/null\n');
      }
      if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(patch)) {
        throw new WorktreeFileCaptureError('binary');
      }
      if (!patch.startsWith('diff --git ') || !patch.endsWith('\n')) {
        throw new WorktreeFileCaptureError('capture_failed');
      }
      if (lineCount(patchBytes) > MAX_WORKTREE_PATCH_LINES) {
        throw new WorktreeFileCaptureError('line_limit');
      }
      if (file.tracked && file.status !== 'deleted' && state) {
        const afterHash = /^index [0-9a-f]+\.\.([0-9a-f]+)(?: [0-7]{6})?$/m.exec(patch)?.[1];
        if (afterHash) {
          const actualHash = await withStableWorktreeFile(state, remainingTime, handle =>
            runGit(['hash-object', `--path=${file.path}`, '--stdin'], {
              stdinFd: handle.fd,
              maxOutputBytes: 65,
            })
          );
          if (decodeWorktreeUtf8(actualHash) !== `${afterHash}\n`) {
            throw new WorktreeFileCaptureError('inconsistent');
          }
        } else if (file.additions !== 0 || file.deletions !== 0) {
          throw new WorktreeFileCaptureError('inconsistent');
        }
      }
      const failure = replace({
        ...omittedRecord(summary.revision, file, 'budget_exhausted'),
        diff: { status: 'available', patch },
      });
      if (failure) throw new WorktreeFileCaptureError(failure);
      if (input.bytes && input.bytes.length >= MAX_WORKTREE_CONTENT_BYTES) input.bytes = undefined;
    } catch (error) {
      const reason = fileOmissionReason(error);
      replace(omittedRecord(summary.revision, file, reason));
      const input = contentInputs.get(identity);
      if (input) input.bytes = undefined;
      if (!['too_large', 'line_limit', 'budget_exhausted'].includes(reason)) {
        contentInputs.delete(identity);
      }
    } finally {
      if (!committed) capturedUntracked.delete(file.path);
    }
  }

  for (const file of captureContent ? ordered : []) {
    const identity = worktreeFileIdentity(file);
    const input = contentInputs.get(identity);
    const index = indices.get(identity);
    if (!input || index === undefined) continue;
    const record = records[index];
    try {
      remainingTime();
      if (input.state) await verifyWorktreeFile(input.state);
      let bytes: Buffer;
      if (file.status === 'deleted') {
        const beforeRef =
          file.scope === 'uncommitted' ? summary.comparison.head : summary.comparison.mergeBase;
        bytes =
          input.bytes ?? (await readBlob(beforeRef, file.path, MAX_WORKTREE_CONTENT_BYTES - 1));
      } else if (file.scope === 'against-base-branch') {
        bytes = await readBlob(summary.comparison.head, file.path, MAX_WORKTREE_CONTENT_BYTES - 1);
      } else {
        if (!input.state?.stat || input.state.stat.size >= MAX_WORKTREE_CONTENT_BYTES) {
          throw new WorktreeFileCaptureError('too_large');
        }
        bytes =
          input.bytes ??
          (await readWorktreeFile(input.state, MAX_WORKTREE_CONTENT_BYTES - 1, remainingTime));
      }
      if (input.state) await verifyWorktreeFile(input.state);
      remainingTime();
      if (isBinary(bytes)) throw new WorktreeFileCaptureError('binary');
      const text = decodeWorktreeUtf8(bytes);
      if (bytes.length >= MAX_WORKTREE_CONTENT_BYTES)
        throw new WorktreeFileCaptureError('too_large');
      if (lineCount(bytes) > MAX_WORKTREE_CONTENT_LINES) {
        throw new WorktreeFileCaptureError('line_limit');
      }
      const failure = replace({
        ...record,
        content: {
          status: 'available',
          source: file.status === 'deleted' ? 'deleted-original' : 'current',
          text,
        },
      });
      if (failure) throw new WorktreeFileCaptureError(failure);
    } catch (error) {
      const reason = fileOmissionReason(error);
      if (reason === 'inconsistent') {
        replace(omittedRecord(summary.revision, file, reason));
      } else {
        replace({ ...record, content: { status: 'unavailable', reason } });
      }
    }
  }
  return records;
}
