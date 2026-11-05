import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { z } from 'zod';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';
import { WORKTREE_SNAPSHOT_RESTORE_MS } from '../../../src/shared/control-plane-timers.js';
import {
  WORKTREE_SNAPSHOT_CAPTURE_MS,
  WORKTREE_SNAPSHOT_MAX_BYTES,
} from '../../../src/shared/worktree-snapshot.js';
import { git, logToFile } from '../utils.js';
import {
  WorktreeFileCaptureError,
  inspectWorktreeFile,
  sameFile,
  verifyWorktreeFile,
  type WorktreeFileState,
} from './worktree-file-capture.js';

export const WORKTREE_SNAPSHOT_VERSION = 1;
export const MAX_WORKTREE_SNAPSHOT_FILES = 10_000;
export const MAX_WORKTREE_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WORKTREE_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_WORKTREE_SNAPSHOT_ARCHIVE_BYTES = WORKTREE_SNAPSHOT_MAX_BYTES;

const MAX_SNAPSHOT_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_METADATA_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_OMISSIONS = MAX_WORKTREE_SNAPSHOT_FILES;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const READ_CHUNK_BYTES = 64 * 1024;
const OMISSION_REASONS = [
  'symlink',
  'submodule',
  'not_regular_file',
  'too_large',
  'file_limit',
  'budget_exhausted',
  'unsafe_path',
  'inconsistent',
] as const;

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CAPTURED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const safeRelativePathSchema = z
  .string()
  .refine(isSafeRelativePath, { message: 'snapshot path is unsafe' });
const displayPathSchema = z.string().refine(isDisplayPath, { message: 'snapshot path is invalid' });
const omissionReasonSchema = z.enum(OMISSION_REASONS);
const omissionSchema = z.object({
  path: displayPathSchema,
  reason: omissionReasonSchema,
});
const manifestSchema = z.object({
  version: z.literal(WORKTREE_SNAPSHOT_VERSION),
  worktreeId: z.string().min(1),
  branch: z.string().nullable(),
  base: z.string().regex(COMMIT_PATTERN),
  capturedAt: z
    .string()
    .refine(value => CAPTURED_AT_PATTERN.test(value) && Number.isFinite(Date.parse(value)), {
      message: 'snapshot capture time is invalid',
    }),
  deleted: z
    .array(safeRelativePathSchema)
    .max(MAX_WORKTREE_SNAPSHOT_FILES)
    .refine(paths => new Set(paths).size === paths.length, {
      message: 'snapshot deleted paths must be unique',
    }),
  omitted: z.array(omissionSchema).max(MAX_WORKTREE_SNAPSHOT_FILES),
  partial: z.boolean(),
});

export type WorktreeSnapshotOmissionReason = z.infer<typeof omissionReasonSchema>;

export type WorktreeSnapshotOmission = z.infer<typeof omissionSchema>;

export type WorktreeSnapshotManifest = z.infer<typeof manifestSchema>;

export type WorktreeSnapshotLimits = {
  files: number;
  fileBytes: number;
  totalBytes: number;
  archiveBytes: number;
  manifestBytes: number;
  uncompressedBytes: number;
};

export const WORKTREE_SNAPSHOT_LIMITS: WorktreeSnapshotLimits = {
  files: MAX_WORKTREE_SNAPSHOT_FILES,
  fileBytes: MAX_WORKTREE_SNAPSHOT_FILE_BYTES,
  totalBytes: MAX_WORKTREE_SNAPSHOT_TOTAL_BYTES,
  archiveBytes: MAX_WORKTREE_SNAPSHOT_ARCHIVE_BYTES,
  manifestBytes: MAX_SNAPSHOT_MANIFEST_BYTES,
  uncompressedBytes: MAX_DECOMPRESSED_BYTES,
};

export type CaptureWorktreeSnapshotInput = {
  directory: string;
  worktreeId: string;
  signal: AbortSignal;
};

export type CapturedWorktreeSnapshot = {
  archivePath: string;
  contentDigest: string;
  size: number;
  manifest: WorktreeSnapshotManifest;
  cleanup(): Promise<void>;
};

export type ApplyWorktreeSnapshotInput = {
  directory: string;
  worktreeId: string;
  archivePath: string;
  signal: AbortSignal;
};

export type AppliedWorktreeSnapshot = {
  applied: number;
  omitted: number;
  conflicts: string[];
  partial: boolean;
};

export class InvalidWorktreeSnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidWorktreeSnapshotError';
  }
}

class WorktreeTypeClashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeTypeClashError';
  }
}

class WorktreeSnapshotDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeSnapshotDeadlineError';
  }
}

type Clock = {
  remaining(): number;
};

type CapturedFile = {
  kind: 'file' | 'recovery';
  path: string;
  state: WorktreeFileState;
  mode: number;
  size: number;
};

type ExtractedFile = {
  path: string;
  tempPath: string;
  mode: number;
  size: number;
};

type ExtractedSnapshot = {
  manifest: WorktreeSnapshotManifest;
  files: Map<string, ExtractedFile>;
  recovery: Map<string, ExtractedFile>;
  temporaryDirectory: string;
};

type GitResult = {
  stdout: string;
  exitCode: number;
  truncated: boolean;
};

type ChangedPath = { status: 'deleted' } | { status: 'present'; mode: number; objectId: string };

type ArchiveMember =
  | { kind: 'manifest' }
  | { kind: 'file'; path: string }
  | { kind: 'recovery'; path: string };

type CapturePaths = {
  tracked: string[];
  untracked: string[];
  deleted: string[];
  submodules: string[];
};

const GIT_PREFIX = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
];

const GITLINK_MODE = '160000';
const RECOVERY_PREFIX = 'recovery/';
const RECOVERY_STAMP_PATTERN = /^[0-9A-Za-z._-]{1,256}$/;
const GIT_FILE_MODE = 0o100000;
const GIT_FILE_TYPE_MASK = 0o170000;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deadline(signal: AbortSignal, timeoutMs: number, message: string): Clock {
  const deadlineAt = Date.now() + timeoutMs;
  return {
    remaining() {
      signal.throwIfAborted();
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new WorktreeSnapshotDeadlineError(message);
      return remaining;
    },
  };
}

function safeGitEnv(): NodeJS.ProcessEnv {
  return {
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
    GIT_OPTIONAL_LOCKS: '0',
  };
}

async function runGit(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock,
  options: { allow?: number[] } = {}
): Promise<GitResult> {
  const allow = options.allow ?? [0];
  const result = await git([...GIT_PREFIX, ...args], {
    cwd: root,
    env,
    inheritEnv: false,
    signal,
    timeoutMs: clock.remaining(),
    terminationGraceMs: 250,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  });
  signal.throwIfAborted();
  if (result.terminationReason !== undefined) {
    throw new Error(`git ${args[0] ?? 'command'} terminated: ${result.terminationReason}`);
  }
  if (!allow.includes(result.exitCode)) {
    throw new Error(`git ${args[0] ?? 'command'} failed with exit code ${result.exitCode}`);
  }
  return {
    stdout: result.stdout,
    exitCode: result.exitCode,
    truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
  };
}

function parseNulRecords(output: string): string[] {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new Error('git path list was not NUL terminated');
  return output.slice(0, -1).split('\0');
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value
    .split('/')
    .every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function isDisplayPath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecoveryStamp(value: string): boolean {
  return RECOVERY_STAMP_PATTERN.test(value) && value !== '.' && value !== '..';
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function capturedFileMemberName(file: CapturedFile): string {
  return file.kind === 'recovery' ? `${RECOVERY_PREFIX}${file.path}` : `files/${file.path}`;
}

async function isSubmodulePath(fullPath: string): Promise<boolean> {
  try {
    const entry = await lstat(join(fullPath, '.git'));
    return entry.isDirectory() || entry.isFile();
  } catch {
    return false;
  }
}

function omissionReason(error: unknown): WorktreeSnapshotOmissionReason {
  if (!(error instanceof WorktreeFileCaptureError)) return 'unsafe_path';
  switch (error.reason) {
    case 'too_large':
      return 'too_large';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'inconsistent':
    case 'capture_failed':
      return 'inconsistent';
    default:
      return 'unsafe_path';
  }
}

function asInvalid(error: unknown, message: string): unknown {
  if (error instanceof InvalidWorktreeSnapshotError) return error;
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z]+$/.test(error.code)
  ) {
    return error;
  }
  return new InvalidWorktreeSnapshotError(message, { cause: error });
}

function tarPadding(size: number): number {
  const remainder = size % TAR_BLOCK_BYTES;
  return remainder === 0 ? 0 : TAR_BLOCK_BYTES - remainder;
}

function paxPayloadBytes(name: string): number {
  const payload = Buffer.byteLength(` path=${name}\n`, 'utf8');
  let digits = Math.floor(Math.log10(payload)) + 1;
  if (payload + digits >= 10 ** digits) digits += 1;
  return payload + digits;
}

function tarEntryBytes(name: string, size: number): number {
  const nameBytes = Buffer.byteLength(name, 'utf8');
  const needsPax = nameBytes > 100 || nameBytes !== name.length;
  const headerBytes = needsPax
    ? TAR_BLOCK_BYTES * 2 + paxPayloadBytes(name) + tarPadding(paxPayloadBytes(name))
    : TAR_BLOCK_BYTES;
  return headerBytes + size + tarPadding(size);
}

function canonicalManifest(manifest: WorktreeSnapshotManifest): string {
  return JSON.stringify({
    version: manifest.version,
    worktreeId: manifest.worktreeId,
    branch: manifest.branch,
    base: manifest.base,
    deleted: manifest.deleted,
    omitted: manifest.omitted,
    partial: manifest.partial,
  });
}

async function readFileChunk(
  handle: FileHandle,
  offset: number,
  length: number
): Promise<{ bytes: Buffer; bytesRead: number }> {
  const bytes = Buffer.allocUnsafe(Math.min(length, READ_CHUNK_BYTES));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
  return { bytes: bytes.subarray(0, bytesRead), bytesRead };
}

async function writeArchive(
  archivePath: string,
  manifest: WorktreeSnapshotManifest,
  files: CapturedFile[],
  clock: Clock
): Promise<string> {
  const digest = createHash('sha256');
  digest.update(canonicalManifest(manifest));
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const archive = tarPack();
  const completion = pipeline(
    archive,
    createGzip(),
    createWriteStream(archivePath, { mode: 0o600, flags: 'wx' })
  );

  try {
    clock.remaining();
    await new Promise<void>((resolve, reject) => {
      archive.entry(
        {
          name: 'snapshot.json',
          mode: 0o644,
          size: manifestBytes.length,
          mtime: new Date(0),
          type: 'file',
        },
        manifestBytes,
        error => (error ? reject(error) : resolve())
      );
    });

    for (const file of files) {
      clock.remaining();
      const memberName = capturedFileMemberName(file);
      digest.update(
        `\0${file.kind}\0${file.path}\0${file.mode.toString(8)}\0${file.size.toString(10)}\0`
      );
      const expected = file.state.stat;
      if (!expected) throw new Error('worktree file identity was not captured');
      await verifyWorktreeFile(file.state);

      async function* chunks(): AsyncGenerator<Buffer> {
        const handle = await open(
          file.state.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        let offset = 0;
        try {
          if (!sameFile(expected, await handle.stat())) {
            throw new Error('worktree file changed during capture');
          }
          while (offset < file.size) {
            clock.remaining();
            const chunk = await readFileChunk(handle, offset, file.size - offset);
            if (chunk.bytesRead === 0) {
              throw new Error('worktree file changed during capture');
            }
            digest.update(chunk.bytes);
            yield chunk.bytes;
            offset += chunk.bytesRead;
          }
          if (!sameFile(expected, await handle.stat())) {
            throw new Error('worktree file changed during capture');
          }
          await verifyWorktreeFile(file.state);
        } finally {
          await handle.close();
        }
      }

      const source = Readable.from(chunks());
      await new Promise<void>((resolve, reject) => {
        const sink = archive.entry(
          {
            name: memberName,
            mode: file.mode,
            size: file.size,
            mtime: new Date(0),
            type: 'file',
          },
          error => {
            if (error) {
              source.destroy();
              reject(error);
            } else {
              resolve();
            }
          }
        );
        source.on('error', error => sink.destroy(error));
        source.pipe(sink);
      });
    }

    archive.finalize();
    await completion;
    return digest.digest('hex');
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await completion.catch(() => undefined);
    throw error;
  }
}

async function isNonDirectoryOnDisk(path: string): Promise<boolean> {
  try {
    return !(await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function collectCapturePaths(
  root: string,
  base: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock
): Promise<CapturePaths> {
  const diff = await runGit(
    root,
    [
      'diff',
      '--raw',
      '--no-renames',
      '--no-ext-diff',
      '--ignore-submodules=none',
      '-z',
      base,
      '--',
    ],
    env,
    signal,
    clock
  );
  if (diff.truncated) throw new Error('git diff output exceeded the capture limit');
  const records = parseNulRecords(diff.stdout);
  if (records.length % 2 !== 0) throw new Error('git diff returned an incomplete record');

  const tracked: string[] = [];
  const deleted: string[] = [];
  const submodules: string[] = [];
  const deletedSet = new Set<string>();
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 2) {
    const meta = records[index];
    const path = records[index + 1];
    const fields = meta.startsWith(':') ? meta.slice(1).split(' ') : [];
    const [oldMode, newMode, , , status] = fields;
    if (!path || fields.length !== 5 || status?.length !== 1) {
      throw new Error('git diff returned an invalid record');
    }
    if (newMode === GITLINK_MODE || (oldMode === GITLINK_MODE && status === 'D')) {
      if (!seen.has(path)) {
        seen.add(path);
        submodules.push(path);
      }
      continue;
    }
    // An ignored file removed from the index with `git rm --cached` is still on
    // disk but absent from `ls-files --others`; capture it rather than delete it.
    if (status === 'D' && !(await isNonDirectoryOnDisk(join(root, path)))) {
      if (!deletedSet.has(path)) {
        deletedSet.add(path);
        deleted.push(path);
      }
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (status === 'A' || status === 'D' || status === 'M' || status === 'T' || status === 'U')
      tracked.push(path);
    else throw new Error(`git diff returned unsupported status ${status}`);
  }

  const others = await runGit(
    root,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    env,
    signal,
    clock
  );
  if (others.truncated) throw new Error('git untracked output exceeded the capture limit');
  const untracked = parseNulRecords(others.stdout).filter(path => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });

  tracked.sort(compareStrings);
  untracked.sort(compareStrings);
  deleted.sort(compareStrings);
  submodules.sort(compareStrings);
  return { tracked, untracked, deleted, submodules };
}

async function collectRecoveryDirectory(
  stamp: string,
  subDirectory: string,
  absoluteDirectory: string,
  paths: string[],
  clock: Clock
): Promise<void> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    clock.remaining();
    const subPath = subDirectory === '' ? entry.name : `${subDirectory}/${entry.name}`;
    if (!isSafeRelativePath(subPath) || entry.isSymbolicLink()) {
      throw new Error('worktree snapshot recovery entry is unsafe');
    }
    const absolute = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectRecoveryDirectory(stamp, subPath, absolute, paths, clock);
      continue;
    }
    if (!entry.isFile()) throw new Error('worktree snapshot recovery entry is unsafe');
    paths.push(`${stamp}/${subPath}`);
  }
}

async function collectRecoveryPaths(root: string, clock: Clock): Promise<string[]> {
  const gitDirectory = join(root, '.git');
  const gitEntry = await lstat(gitDirectory).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (!gitEntry?.isDirectory()) return [];
  const recoveryRoot = join(gitDirectory, 'kilo-recovered');
  const recoveryEntry = await lstat(recoveryRoot).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (!recoveryEntry) return [];
  if (!recoveryEntry.isDirectory()) {
    throw new Error('worktree snapshot recovery path is not a directory');
  }

  const paths: string[] = [];
  const stamps = await readdir(recoveryRoot, { withFileTypes: true });
  stamps.sort((left, right) => compareStrings(left.name, right.name));
  for (const stamp of stamps) {
    clock.remaining();
    if (!isRecoveryStamp(stamp.name) || !stamp.isDirectory()) {
      throw new Error('worktree snapshot recovery path is unsafe');
    }
    await collectRecoveryDirectory(stamp.name, '', join(recoveryRoot, stamp.name), paths, clock);
  }
  return paths;
}

async function captureRecoveryFiles(
  root: string,
  limits: WorktreeSnapshotLimits,
  clock: Clock
): Promise<{ files: CapturedFile[]; totalBytes: number; tarBytes: number }> {
  const paths = await collectRecoveryPaths(root, clock);
  if (paths.length === 0) return { files: [], totalBytes: 0, tarBytes: 0 };

  const fileLimit = Math.min(limits.files, MAX_WORKTREE_SNAPSHOT_FILES);
  if (paths.length > fileLimit) {
    throw new Error('worktree snapshot recovery payload exceeded the file limit');
  }
  const fileBytesLimit = Math.min(limits.fileBytes, MAX_WORKTREE_SNAPSHOT_FILE_BYTES);
  const totalBytesLimit = Math.min(limits.totalBytes, MAX_WORKTREE_SNAPSHOT_TOTAL_BYTES);
  const files: CapturedFile[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    clock.remaining();
    let state: WorktreeFileState;
    try {
      state = await inspectWorktreeFile(
        root,
        ['.git', 'kilo-recovered', ...path.split('/')].join('/')
      );
    } catch {
      throw new Error('worktree snapshot recovery entry is unsafe');
    }
    const entry = state.stat;
    if (!entry) throw new Error('worktree snapshot recovery entry is unsafe');
    if (entry.size > fileBytesLimit) {
      throw new Error('worktree snapshot recovery file exceeded the size limit');
    }
    if (totalBytes + entry.size > totalBytesLimit) {
      throw new Error('worktree snapshot recovery payload exceeded the size limit');
    }
    const mode = (entry.mode & 0o111) === 0 ? 0o644 : 0o755;
    files.push({ kind: 'recovery', path, state, mode, size: entry.size });
    totalBytes += entry.size;
  }

  const tarBytes = files.reduce(
    (total, file) => total + tarEntryBytes(`recovery/${file.path}`, file.size),
    0
  );
  const manifestLimit = Math.min(limits.manifestBytes, MAX_SNAPSHOT_MANIFEST_BYTES);
  const uncompressedLimit = Math.min(limits.uncompressedBytes, MAX_DECOMPRESSED_BYTES);
  const manifestReserve = tarEntryBytes('snapshot.json', manifestLimit);
  if (manifestReserve + tarBytes + TAR_BLOCK_BYTES * 2 > uncompressedLimit) {
    throw new Error('worktree snapshot recovery payload exceeded the decompressed limit');
  }
  return { files, totalBytes, tarBytes };
}

function boundManifestSize(
  manifest: WorktreeSnapshotManifest,
  maxBytes: number,
  clock: Clock
): WorktreeSnapshotManifest {
  let bytes = Buffer.byteLength(JSON.stringify(manifest));
  if (bytes <= maxBytes) return manifest;

  if (!manifest.partial) {
    manifest.partial = true;
    bytes -= 1;
  }
  let iterations = 0;
  while (bytes > maxBytes && manifest.omitted.length > 0) {
    if ((iterations++ & 0xff) === 0) clock.remaining();
    const removed = manifest.omitted.pop();
    if (!removed) break;
    bytes -= Buffer.byteLength(JSON.stringify(removed)) + (manifest.omitted.length > 0 ? 1 : 0);
  }
  while (bytes > maxBytes && manifest.deleted.length > 0) {
    if ((iterations++ & 0xff) === 0) clock.remaining();
    const removed = manifest.deleted.pop();
    if (!removed) break;
    bytes -= Buffer.byteLength(JSON.stringify(removed)) + (manifest.deleted.length > 0 ? 1 : 0);
  }
  if (Buffer.byteLength(JSON.stringify(manifest)) > maxBytes) {
    throw new Error('worktree snapshot manifest exceeded the size limit');
  }
  return manifest;
}

async function captureFilesAndManifest(
  root: string,
  worktreeId: string,
  branch: string | null,
  base: string,
  paths: CapturePaths,
  limits: WorktreeSnapshotLimits,
  retained: { files: number; totalBytes: number; tarBytes: number },
  clock: Clock
): Promise<{ manifest: WorktreeSnapshotManifest; files: CapturedFile[] }> {
  const files: CapturedFile[] = [];
  const omitted: WorktreeSnapshotOmission[] = [];
  let partial = false;
  let totalBytes = retained.totalBytes;
  let budgetExhausted = false;

  function omit(path: string, reason: WorktreeSnapshotOmissionReason): void {
    partial = true;
    if (omitted.length < MAX_SNAPSHOT_OMISSIONS) {
      omitted.push({ path: path.slice(0, 4096), reason });
    }
  }

  for (const path of paths.submodules) omit(path, 'submodule');

  const ordered = [...paths.tracked, ...paths.untracked];
  const candidatePaths = new Set<string>();
  for (const rawPath of ordered) {
    candidatePaths.add(rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath);
  }

  const deleted: string[] = [];
  const deletedSet = new Set<string>();
  const fileLimit = Math.min(limits.files, MAX_WORKTREE_SNAPSHOT_FILES);
  const remainingFileLimit = Math.max(0, fileLimit - retained.files);
  for (const path of paths.deleted) {
    if (candidatePaths.has(path) || deletedSet.has(path)) continue;
    if (!isSafeRelativePath(path)) {
      omit(path, 'unsafe_path');
      continue;
    }
    if (deleted.length >= remainingFileLimit) {
      omit(path, 'file_limit');
      continue;
    }
    deletedSet.add(path);
    deleted.push(path);
  }

  for (const rawPath of ordered) {
    clock.remaining();
    const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    if (!isSafeRelativePath(path)) {
      omit(rawPath, 'unsafe_path');
      continue;
    }
    if (files.length >= remainingFileLimit) {
      omit(path, 'file_limit');
      continue;
    }
    if (budgetExhausted) {
      omit(path, 'budget_exhausted');
      continue;
    }

    const fullPath = join(root, path);
    let entry;
    try {
      entry = await lstat(fullPath);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        omit(path, 'inconsistent');
        continue;
      }
      throw error;
    }

    if (entry.isSymbolicLink()) {
      omit(path, 'symlink');
      continue;
    }
    if (!entry.isFile()) {
      omit(path, (await isSubmodulePath(fullPath)) ? 'submodule' : 'not_regular_file');
      continue;
    }
    if (entry.size > limits.fileBytes) {
      omit(path, 'too_large');
      continue;
    }
    if (totalBytes + entry.size > limits.totalBytes) {
      budgetExhausted = true;
      omit(path, 'budget_exhausted');
      continue;
    }

    let state: WorktreeFileState;
    try {
      state = await inspectWorktreeFile(root, path);
    } catch (error) {
      omit(path, omissionReason(error));
      continue;
    }
    const size = state.stat?.size;
    if (size === undefined) throw new Error('worktree file identity was not captured');
    if (size > limits.fileBytes) {
      omit(path, 'too_large');
      continue;
    }
    if (totalBytes + size > limits.totalBytes) {
      budgetExhausted = true;
      omit(path, 'budget_exhausted');
      continue;
    }
    files.push({
      kind: 'file',
      path,
      state,
      mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755,
      size,
    });
    totalBytes += size;
  }

  const manifestLimit = Math.min(limits.manifestBytes, MAX_SNAPSHOT_MANIFEST_BYTES);
  const uncompressedLimit = Math.min(limits.uncompressedBytes, MAX_DECOMPRESSED_BYTES);
  const manifestReserve = tarEntryBytes('snapshot.json', manifestLimit);
  const fileBudget = uncompressedLimit - manifestReserve - retained.tarBytes - TAR_BLOCK_BYTES * 2;
  let fileEntryBytes = files.reduce(
    (total, file) => total + tarEntryBytes(`files/${file.path}`, file.size),
    0
  );
  let droppedCount = 0;
  while (fileEntryBytes > fileBudget && files.length > 0) {
    if ((droppedCount++ & 0xff) === 0) clock.remaining();
    const dropped = files.pop();
    if (!dropped) break;
    fileEntryBytes -= tarEntryBytes(`files/${dropped.path}`, dropped.size);
    omit(dropped.path, 'budget_exhausted');
  }

  omitted.sort((left, right) => compareStrings(left.path, right.path));
  deleted.sort(compareStrings);

  return {
    manifest: boundManifestSize(
      {
        version: WORKTREE_SNAPSHOT_VERSION,
        worktreeId,
        branch,
        base,
        capturedAt: new Date().toISOString(),
        deleted,
        omitted,
        partial,
      },
      manifestLimit,
      clock
    ),
    files,
  };
}

export async function captureWorktreeSnapshot(
  input: CaptureWorktreeSnapshotInput
): Promise<CapturedWorktreeSnapshot | null> {
  return captureWorktreeSnapshotWithLimits(input, WORKTREE_SNAPSHOT_LIMITS);
}

export async function captureWorktreeSnapshotWithLimits(
  input: CaptureWorktreeSnapshotInput,
  limits: WorktreeSnapshotLimits
): Promise<CapturedWorktreeSnapshot | null> {
  const { directory, worktreeId, signal } = input;
  signal.throwIfAborted();
  if (worktreeId.length === 0 || worktreeId.length > 256) {
    throw new Error('worktree id is invalid');
  }
  const root = await realpath(directory);
  const gitEnv = safeGitEnv();
  const clock = deadline(
    signal,
    WORKTREE_SNAPSHOT_CAPTURE_MS,
    'worktree snapshot capture timed out'
  );

  const branchResult = await runGit(
    root,
    ['symbolic-ref', '--short', '-q', 'HEAD'],
    gitEnv,
    signal,
    clock,
    { allow: [0, 1] }
  );
  const branch =
    branchResult.exitCode === 0 && branchResult.stdout.trim() !== ''
      ? branchResult.stdout.trim()
      : null;

  let base: string | undefined;
  if (branch) {
    const remote = await runGit(
      root,
      ['rev-parse', '--verify', '-q', '--end-of-options', `refs/remotes/origin/${branch}`],
      gitEnv,
      signal,
      clock,
      { allow: [0, 1] }
    );
    const remoteCommit = remote.stdout.trim();
    if (remote.exitCode === 0 && COMMIT_PATTERN.test(remoteCommit)) {
      const mergeBase = await runGit(
        root,
        ['merge-base', 'HEAD', remoteCommit],
        gitEnv,
        signal,
        clock,
        { allow: [0, 1, 128] }
      );
      const candidate = mergeBase.stdout.trim();
      if (mergeBase.exitCode === 0 && COMMIT_PATTERN.test(candidate)) base = candidate;
    }
  }

  if (!base) {
    const mergeBase = await runGit(
      root,
      ['merge-base', 'HEAD', 'refs/remotes/origin/HEAD'],
      gitEnv,
      signal,
      clock,
      { allow: [0, 1, 128] }
    );
    const candidate = mergeBase.stdout.trim();
    if (mergeBase.exitCode === 0 && COMMIT_PATTERN.test(candidate)) base = candidate;
  }
  if (!base) {
    logToFile(`worktree snapshot skipped for ${worktreeId}: no remote base ref`);
    return null;
  }

  const paths = await collectCapturePaths(root, base, gitEnv, signal, clock);
  const retained = await captureRecoveryFiles(root, limits, clock);
  const { manifest, files } = await captureFilesAndManifest(
    root,
    worktreeId,
    branch,
    base,
    paths,
    limits,
    {
      files: retained.files.length,
      totalBytes: retained.totalBytes,
      tarBytes: retained.tarBytes,
    },
    clock
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'kilo-worktree-snapshot-'));
  await chmod(temporaryDirectory, 0o700);
  const archivePath = join(temporaryDirectory, 'snapshot.tar.gz');
  const cleanup = async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  };

  try {
    const contentDigest = await writeArchive(
      archivePath,
      manifest,
      [...retained.files, ...files],
      clock
    );
    const archive = await stat(archivePath);
    if (archive.size > limits.archiveBytes) {
      throw new Error('worktree snapshot archive exceeded the size limit');
    }
    return { archivePath, contentDigest, size: archive.size, manifest, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function classifyArchiveMember(name: string): ArchiveMember {
  if (name === 'snapshot.json') return { kind: 'manifest' };
  if (name.startsWith('files/')) {
    const path = name.slice('files/'.length);
    if (!isSafeRelativePath(path)) {
      throw new InvalidWorktreeSnapshotError('snapshot archive contains an unsafe path');
    }
    return { kind: 'file', path };
  }
  if (name.startsWith(RECOVERY_PREFIX)) {
    const relative = name.slice(RECOVERY_PREFIX.length);
    const separator = relative.indexOf('/');
    if (separator <= 0) {
      throw new InvalidWorktreeSnapshotError('snapshot archive contains an unsafe recovery path');
    }
    const stamp = relative.slice(0, separator);
    const path = relative.slice(separator + 1);
    if (!isRecoveryStamp(stamp) || !isSafeRelativePath(path)) {
      throw new InvalidWorktreeSnapshotError('snapshot archive contains an unsafe recovery path');
    }
    return { kind: 'recovery', path: `${stamp}/${path}` };
  }
  throw new InvalidWorktreeSnapshotError('snapshot archive contains an unexpected member');
}

function parseManifest(bytes: Buffer): WorktreeSnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new InvalidWorktreeSnapshotError('snapshot manifest is not valid JSON', { cause: error });
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidWorktreeSnapshotError('snapshot manifest is invalid', {
      cause: result.error,
    });
  }
  return result.data;
}

function archiveError(error: unknown): Error {
  if (
    error instanceof InvalidWorktreeSnapshotError ||
    error instanceof WorktreeSnapshotDeadlineError ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'WorktreeSnapshotTimeoutError'))
  ) {
    return error;
  }
  const converted = asInvalid(error, 'snapshot archive is corrupt');
  if (converted instanceof Error) return converted;
  return new InvalidWorktreeSnapshotError('snapshot archive is corrupt', { cause: error });
}

type ArchiveInputBudget = {
  metadataRemaining: number;
  payloadRemaining: number;
};

function archiveInputLimiter(clock: Clock, budget: ArchiveInputBudget): Transform {
  let totalBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        clock.remaining();
      } catch (error) {
        callback(archiveError(error));
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_DECOMPRESSED_BYTES) {
        callback(
          new InvalidWorktreeSnapshotError('snapshot archive decompressed data exceeded the limit')
        );
        return;
      }

      let offset = 0;
      while (offset < chunk.length) {
        if (budget.payloadRemaining > 0) {
          const take = Math.min(budget.payloadRemaining, chunk.length - offset);
          budget.payloadRemaining -= take;
          offset += take;
          continue;
        }
        const take = Math.min(budget.metadataRemaining, chunk.length - offset);
        budget.metadataRemaining -= take;
        offset += take;
        if (take === 0) {
          callback(
            new InvalidWorktreeSnapshotError(
              'snapshot archive extended header metadata exceeded the limit'
            )
          );
          return;
        }
      }
      callback(null, chunk);
    },
  });
}

async function extractArchive(
  archivePath: string,
  worktreeId: string,
  clock: Clock
): Promise<ExtractedSnapshot> {
  const archive = await lstat(archivePath);
  if (!archive.isFile()) throw new Error('snapshot archive is not a regular file');
  if (archive.size > MAX_WORKTREE_SNAPSHOT_ARCHIVE_BYTES) {
    throw new InvalidWorktreeSnapshotError('snapshot archive exceeded the size limit');
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'kilo-worktree-snapshot-apply-'));
  await chmod(temporaryDirectory, 0o700);
  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  const budget: ArchiveInputBudget = {
    metadataRemaining: MAX_SNAPSHOT_METADATA_BYTES,
    payloadRemaining: 0,
  };
  const decompressed = archiveInputLimiter(clock, budget);
  const extractor = tarExtract({ filenameEncoding: 'utf8' });
  extractor.on('entry', header => {
    // Rebase the metadata gap at each real entry so file payloads do not consume it.
    const size = header.size ?? 0;
    budget.metadataRemaining = MAX_SNAPSHOT_METADATA_BYTES;
    budget.payloadRemaining = Number.isSafeInteger(size) && size >= 0 ? size + tarPadding(size) : 0;
  });
  input.on('error', error => gunzip.destroy(archiveError(error)));
  gunzip.on('error', error => decompressed.destroy(archiveError(error)));
  decompressed.on('error', error => extractor.destroy(archiveError(error)));
  input.pipe(gunzip).pipe(decompressed).pipe(extractor);
  let complete = false;

  try {
    const files = new Map<string, ExtractedFile>();
    const recovery = new Map<string, ExtractedFile>();
    let manifest: WorktreeSnapshotManifest | undefined;
    let totalFileBytes = 0;

    const iterator = extractor[Symbol.asyncIterator]();
    while (true) {
      clock.remaining();
      let next;
      try {
        next = await iterator.next();
      } catch (error) {
        throw archiveError(error);
      }
      if (next.done) break;
      clock.remaining();

      const entry = next.value;
      try {
        if (entry.header.type !== 'file') {
          throw new InvalidWorktreeSnapshotError('snapshot archive has an unsupported entry type');
        }
        const member = classifyArchiveMember(entry.header.name);
        const size = entry.header.size ?? 0;
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new InvalidWorktreeSnapshotError('snapshot archive has an invalid entry size');
        }

        if (member.kind === 'manifest') {
          if (manifest) {
            throw new InvalidWorktreeSnapshotError('snapshot archive has duplicate manifests');
          }
          if (size > MAX_SNAPSHOT_MANIFEST_BYTES) {
            throw new InvalidWorktreeSnapshotError('snapshot manifest exceeded the size limit');
          }
          const chunks: Buffer[] = [];
          let manifestBytes = 0;
          for await (const chunk of entry) {
            clock.remaining();
            manifestBytes += chunk.length;
            if (manifestBytes > MAX_SNAPSHOT_MANIFEST_BYTES) {
              throw new InvalidWorktreeSnapshotError('snapshot manifest exceeded the size limit');
            }
            chunks.push(chunk);
          }
          if (manifestBytes !== size) {
            throw new InvalidWorktreeSnapshotError('snapshot archive is truncated');
          }
          manifest = parseManifest(Buffer.concat(chunks, manifestBytes));
          continue;
        }

        const target = member.kind === 'recovery' ? recovery : files;
        if (target.has(member.path)) {
          throw new InvalidWorktreeSnapshotError('snapshot archive has duplicate file entries');
        }
        if (files.size + recovery.size >= MAX_WORKTREE_SNAPSHOT_FILES) {
          throw new InvalidWorktreeSnapshotError('snapshot archive has too many file entries');
        }
        if (size > MAX_WORKTREE_SNAPSHOT_FILE_BYTES) {
          throw new InvalidWorktreeSnapshotError('snapshot archive file exceeded the size limit');
        }
        if (totalFileBytes + size > MAX_DECOMPRESSED_BYTES) {
          throw new InvalidWorktreeSnapshotError(
            'snapshot archive exceeded the decompressed limit'
          );
        }
        const mode = entry.header.mode ?? 0;
        if (mode !== 0o644 && mode !== 0o755) {
          throw new InvalidWorktreeSnapshotError('snapshot archive has an unsupported file mode');
        }

        const destination =
          member.kind === 'recovery'
            ? join(temporaryDirectory, 'recovery', ...member.path.split('/'))
            : join(temporaryDirectory, 'files', ...member.path.split('/'));
        try {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        } catch (error) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'ENOTDIR' || error.code === 'EEXIST' || error.code === 'EISDIR')
          ) {
            throw new InvalidWorktreeSnapshotError('snapshot archive has conflicting paths');
          }
          throw error;
        }
        let handle: FileHandle;
        try {
          handle = await open(destination, 'wx', 0o600);
        } catch (error) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'ENOTDIR' || error.code === 'EEXIST' || error.code === 'EISDIR')
          ) {
            throw new InvalidWorktreeSnapshotError('snapshot archive has conflicting paths');
          }
          throw error;
        }
        let written = 0;
        try {
          for await (const chunk of entry) {
            clock.remaining();
            written += chunk.length;
            if (written > size) {
              throw new InvalidWorktreeSnapshotError('snapshot archive is truncated');
            }
            let offset = 0;
            while (offset < chunk.length) {
              const result = await handle.write(chunk, offset, chunk.length - offset);
              if (result.bytesWritten === 0) {
                throw new Error('snapshot extraction write made no progress');
              }
              offset += result.bytesWritten;
            }
          }
        } finally {
          await handle.close();
        }
        if (written !== size) {
          throw new InvalidWorktreeSnapshotError('snapshot archive is truncated');
        }
        await chmod(destination, mode);
        target.set(member.path, { path: member.path, tempPath: destination, mode, size });
        totalFileBytes += size;
      } catch (error) {
        throw archiveError(error);
      }
    }

    if (!manifest) {
      throw new InvalidWorktreeSnapshotError('snapshot archive has no manifest');
    }
    if (manifest.worktreeId !== worktreeId) {
      throw new InvalidWorktreeSnapshotError('snapshot archive belongs to another worktree');
    }
    complete = true;
    return { manifest, files, recovery, temporaryDirectory };
  } finally {
    input.destroy();
    gunzip.destroy();
    decompressed.destroy();
    extractor.destroy();
    if (!complete) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function resolveHead(
  root: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock
): Promise<string | undefined> {
  const result = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], env, signal, clock, {
    allow: [0, 1],
  });
  const head = result.stdout.trim();
  return result.exitCode === 0 && COMMIT_PATTERN.test(head) ? head : undefined;
}

async function commitExists(
  root: string,
  commit: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock
): Promise<boolean> {
  const result = await runGit(root, ['cat-file', '-e', `${commit}^{commit}`], env, signal, clock, {
    allow: [0, 1, 128],
  });
  return result.exitCode === 0;
}

async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock
): Promise<boolean> {
  const result = await runGit(
    root,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    env,
    signal,
    clock,
    { allow: [0, 1] }
  );
  return result.exitCode === 0;
}

async function changedPaths(
  root: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock
): Promise<Map<string, ChangedPath>> {
  const result = await runGit(
    root,
    [
      'diff',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--no-ext-diff',
      '--ignore-submodules=none',
      '-z',
      base,
      head,
      '--',
    ],
    env,
    signal,
    clock
  );
  if (result.truncated) throw new Error('git diff output exceeded the apply limit');
  const records = parseNulRecords(result.stdout);
  if (records.length % 2 !== 0) throw new Error('git diff returned an incomplete record');

  const changed = new Map<string, ChangedPath>();
  for (let index = 0; index < records.length; index += 2) {
    const meta = records[index];
    const path = records[index + 1];
    const fields = meta.startsWith(':') ? meta.slice(1).split(' ') : [];
    const [, newMode, , newObjectId, status] = fields;
    if (!path || fields.length !== 5 || status?.length !== 1) {
      throw new Error('git diff returned an invalid record');
    }
    if (status === 'D') {
      changed.set(path, { status: 'deleted' });
      continue;
    }
    if (!newMode || newMode === '000000' || !newObjectId || !COMMIT_PATTERN.test(newObjectId)) {
      throw new Error('git diff returned an invalid record');
    }
    changed.set(path, {
      status: 'present',
      mode: Number.parseInt(newMode, 8),
      objectId: newObjectId,
    });
  }
  return changed;
}

function gitBlobObjectId(bytes: Buffer, objectId: string): string {
  const hash = createHash(objectId.length === 64 ? 'sha256' : 'sha1');
  hash.update(`blob ${bytes.length}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

function snapshotModeMatchesHead(mode: number | undefined, snapshotMode: number): boolean {
  if (mode === undefined || (mode & GIT_FILE_TYPE_MASK) !== GIT_FILE_MODE) return false;
  return ((mode & 0o111) !== 0) === ((snapshotMode & 0o111) !== 0);
}

async function readExtractedFileBytes(file: ExtractedFile): Promise<Buffer> {
  const handle = await open(file.tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('snapshot archive file is truncated');
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function workingFileMatchesSnapshot(
  root: string,
  file: ExtractedFile,
  expected: Buffer
): Promise<boolean> {
  let state: WorktreeFileState;
  try {
    state = await inspectWorktreeFile(root, file.path);
  } catch {
    return false;
  }
  const entry = state.stat;
  if (!entry?.isFile() || entry.size !== expected.length) return false;
  if (((entry.mode & 0o111) !== 0) !== ((file.mode & 0o111) !== 0)) return false;

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      state.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    if (!sameFile(entry, await handle.stat())) return false;
    const bytes = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await readFileChunk(handle, offset, bytes.length - offset);
      if (chunk.bytesRead === 0) return false;
      chunk.bytes.copy(bytes, offset);
      offset += chunk.bytesRead;
    }
    if (!sameFile(entry, await handle.stat())) return false;
    return bytes.equals(expected);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

async function walkSafeParents(
  root: string,
  segments: string[],
  create: boolean
): Promise<string | undefined> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let entry = await lstat(current).catch((error: unknown) => {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return undefined;
      }
      throw error;
    });
    if (!entry) {
      if (!create) return undefined;
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        if (isTypeClash(error)) throw new WorktreeTypeClashError(current);
        throw error;
      }
      entry = await lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new WorktreeTypeClashError(current);
    }
    if ((await realpath(current)) !== current) {
      throw new WorktreeTypeClashError(current);
    }
  }
  return current;
}

async function ensureSafeDirectory(root: string, segments: string[]): Promise<string> {
  const directory = await walkSafeParents(root, segments, true);
  if (directory === undefined) throw new Error('worktree snapshot directory was not created');
  return directory;
}

function isTypeClash(error: unknown): boolean {
  if (error instanceof WorktreeTypeClashError) return true;
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  return (
    error.code === 'ENOTDIR' ||
    error.code === 'EISDIR' ||
    error.code === 'ENOTEMPTY' ||
    error.code === 'EEXIST' ||
    error.code === 'ELOOP'
  );
}

async function copyFileStream(source: string, destination: string, mode: number): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: FileHandle | undefined;
  try {
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      mode
    );
    let position = 0;
    while (true) {
      const chunk = await readFileChunk(input, position, READ_CHUNK_BYTES);
      if (chunk.bytesRead === 0) break;
      let written = 0;
      while (written < chunk.bytesRead) {
        const result = await output.write(
          chunk.bytes,
          written,
          chunk.bytesRead - written,
          position + written
        );
        if (result.bytesWritten === 0) throw new Error('snapshot apply write made no progress');
        written += result.bytesWritten;
      }
      position += chunk.bytesRead;
    }
  } finally {
    await input.close();
    if (output) await output.close();
  }
  await chmod(destination, mode);
}

async function replaceWithFile(
  root: string,
  path: string,
  source: string,
  mode: number
): Promise<void> {
  const parts = path.split('/');
  await ensureSafeDirectory(root, parts.slice(0, -1));
  const destination = join(root, ...parts);
  const existing = await lstat(destination).catch((error: unknown) => {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  });
  if (existing?.isDirectory()) {
    throw new WorktreeTypeClashError(path);
  }
  if (existing) {
    try {
      await unlink(destination);
    } catch (error) {
      if (isTypeClash(error)) throw new WorktreeTypeClashError(path);
      throw error;
    }
  }
  await copyFileStream(source, destination, mode);
}

async function removeEmptyParents(root: string, path: string): Promise<void> {
  const parts = path.split('/');
  for (let count = parts.length - 1; count > 0; count -= 1) {
    const directory = join(root, ...parts.slice(0, count));
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' ||
          error.code === 'ENOTDIR' ||
          error.code === 'ENOTEMPTY' ||
          error.code === 'EEXIST')
      ) {
        return;
      }
      throw error;
    }
  }
}

async function deleteSnapshotPath(
  root: string,
  path: string
): Promise<'deleted' | 'missing' | 'clash'> {
  const parts = path.split('/');
  let parent: string | undefined;
  try {
    parent = await walkSafeParents(root, parts.slice(0, -1), false);
  } catch (error) {
    if (isTypeClash(error)) return 'clash';
    throw error;
  }
  if (parent === undefined) return 'missing';

  const destination = join(root, ...parts);
  const entry = await lstat(destination).catch((error: unknown) => {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  });
  if (!entry) return 'missing';
  if (entry.isDirectory()) {
    try {
      await rmdir(destination);
    } catch (error) {
      if (isTypeClash(error)) return 'clash';
      throw error;
    }
  } else {
    try {
      await unlink(destination);
    } catch (error) {
      if (isTypeClash(error)) return 'clash';
      throw error;
    }
  }
  await removeEmptyParents(root, path);
  return 'deleted';
}

function conflictDirectoryName(capturedAt: string): string {
  return capturedAt.replace(/[^0-9A-Za-z._-]/g, '-');
}

async function writeConflictCopy(
  root: string,
  capturedAt: string,
  file: ExtractedFile
): Promise<void> {
  const stamp = conflictDirectoryName(capturedAt);
  const relative = ['.git', 'kilo-recovered', stamp, ...file.path.split('/')].join('/');
  await replaceWithFile(root, relative, file.tempPath, file.mode);
}

async function applyExtracted(
  root: string,
  extracted: ExtractedSnapshot,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  clock: Clock
): Promise<AppliedWorktreeSnapshot> {
  const { manifest, files, recovery } = extracted;
  const head = await resolveHead(root, env, signal, clock);
  const baseExists = await commitExists(root, manifest.base, env, signal, clock);
  const ancestor =
    baseExists && head ? await isAncestor(root, manifest.base, head, env, signal, clock) : false;
  const allConflict = !head || !baseExists || !ancestor;
  const changed =
    !allConflict && head && head !== manifest.base
      ? await changedPaths(root, manifest.base, head, env, signal, clock)
      : new Map<string, ChangedPath>();
  const conflicts = new Set<string>();
  let applied = 0;

  const orderedRecovery = [...recovery.values()].sort((left, right) =>
    compareStrings(left.path, right.path)
  );
  for (const file of orderedRecovery) {
    clock.remaining();
    const relative = ['.git', 'kilo-recovered', ...file.path.split('/')].join('/');
    try {
      await replaceWithFile(root, relative, file.tempPath, file.mode);
    } catch (error) {
      if (error instanceof WorktreeTypeClashError) {
        throw new Error('worktree snapshot recovery path is blocked');
      }
      throw error;
    }
  }

  const deletedPaths = [...manifest.deleted].sort(
    (left, right) => right.split('/').length - left.split('/').length || compareStrings(left, right)
  );
  for (const path of deletedPaths) {
    clock.remaining();
    let conflict = allConflict;
    if (!allConflict && head && changed.get(path)?.status === 'present') {
      conflict = true;
    }
    if (conflict) {
      conflicts.add(path);
      continue;
    }
    const outcome = await deleteSnapshotPath(root, path);
    if (outcome === 'clash') conflicts.add(path);
    else if (outcome === 'deleted') applied += 1;
  }

  const orderedFiles = [...files.values()].sort((left, right) =>
    compareStrings(left.path, right.path)
  );
  for (const file of orderedFiles) {
    clock.remaining();
    let conflict = allConflict;
    if (!allConflict && head) {
      const change = changed.get(file.path);
      if (change?.status === 'deleted') {
        conflict = true;
      } else if (change) {
        if (!snapshotModeMatchesHead(change.mode, file.mode)) {
          conflict = true;
        } else {
          const snapshot = await readExtractedFileBytes(file);
          if (gitBlobObjectId(snapshot, change.objectId) !== change.objectId) {
            conflict = true;
          } else if (await workingFileMatchesSnapshot(root, file, snapshot)) {
            continue;
          }
        }
      }
    }

    if (conflict) {
      conflicts.add(file.path);
      await writeConflictCopy(root, manifest.capturedAt, file);
      continue;
    }

    try {
      await replaceWithFile(root, file.path, file.tempPath, file.mode);
      applied += 1;
    } catch (error) {
      if (!isTypeClash(error)) throw error;
      conflicts.add(file.path);
      await writeConflictCopy(root, manifest.capturedAt, file);
    }
  }

  return {
    applied,
    omitted: manifest.omitted.length,
    conflicts: [...conflicts].sort(compareStrings),
    partial: manifest.partial,
  };
}

export async function applyWorktreeSnapshot(
  input: ApplyWorktreeSnapshotInput
): Promise<AppliedWorktreeSnapshot> {
  const { directory, worktreeId, archivePath, signal } = input;
  signal.throwIfAborted();
  const root = await realpath(directory);
  const gitEnv = safeGitEnv();
  const clock = deadline(signal, WORKTREE_SNAPSHOT_RESTORE_MS, 'worktree snapshot apply timed out');
  const extracted = await extractArchive(archivePath, worktreeId, clock);
  try {
    return await applyExtracted(root, extracted, gitEnv, signal, clock);
  } finally {
    await rm(extracted.temporaryDirectory, { recursive: true, force: true });
  }
}
