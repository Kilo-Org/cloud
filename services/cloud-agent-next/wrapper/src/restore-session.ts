import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { WorkspaceFailureSubtype } from '../../src/shared/wrapper-bootstrap.js';
import {
  createSafeProcessDiagnostic,
  isTimeoutTermination,
  logToFile,
  runProcess,
} from './utils.js';

export type RestoreSkipReason =
  | 'patch_apply_failed'
  | 'outside_workspace'
  | 'missing_content'
  | 'unlink_failed'
  | 'write_failed'
  | 'index_reset_failed';

export type RestoreDiffSkip = { file: string; reason: RestoreSkipReason };

export type RestoreResult =
  | {
      ok: true;
      downloaded: boolean;
      imported: true;
      diffs: {
        applied: number;
        skipped: number;
        total: number;
        skippedDiffs?: RestoreDiffSkip[];
      };
    }
  | {
      ok: false;
      error: string;
      code: number | null;
      step: 'download' | 'import' | 'diffs';
      subtype?: WorkspaceFailureSubtype;
      detail?: string;
      emptySnapshot?: true;
    };

type SnapshotDiff = {
  file: string;
  after?: string;
  patch?: string;
  status: string;
};

export type RestoreSessionOptions = {
  env?: NodeJS.ProcessEnv;
  importTimeoutMs?: number;
  importTerminationGraceMs?: number;
  downloadTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSnapshotBytes?: number;
  signal?: AbortSignal;
};

const KILO_IMPORT_TIMEOUT_MS = 120_000;
const KILO_DOWNLOAD_TIMEOUT_MS = 120_000;
const KILO_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const MAX_SESSION_EXPORT_BYTES = 1024 * 1024 * 1024;
// Bound the recorded skip list: a pathological snapshot with thousands of
// skipped diffs must not blow the session-ready ingest frame budget. `skipped`
// stays the true count; only the named record is capped.
const MAX_RECORDED_SKIPPED_DIFFS = 100;
const EMPTY_SESSION_INGEST_EXPORT = '{"info":{},"messages":[],"sessionDiff":[]}';
const MAX_EMPTY_SNAPSHOT_BYTES = 1_024;
const JQ_SANITIZE_TOKEN_COUNTS_FILTER =
  'walk(if type == "object" and ((.tokens? | type) == "object") then .tokens |= walk(if type == "number" and . < 0 then 0 else . end) else . end)';
// Drop leftover CLI UI progress parts (metadata.kilocode.lifecycle == "transient").
// These leak into durable session history when snapshot progress cleanup fails; on
// restore, toModelMessages copies part.metadata into providerOptions and AI SDK
// rejects string values under providerOptions.kilocode.lifecycle.
// The type guard keeps the filter total: non-object snapshots pass through
// unchanged instead of producing empty output that sanitizeSnapshotWithJq would
// mistake for success and rename (0 bytes) over a user-supplied --file snapshot.
const JQ_SANITIZE_TRANSIENT_PARTS_FILTER =
  'if type == "object" and (.messages | type) == "array" then .messages |= map(if type == "object" and (.parts | type) == "array" then .parts |= map(select((type != "object") or ((.metadata["kilocode.lifecycle"]? // null) != "transient"))) else . end) else . end';
// Both sanitizations run in a single jq pass so the snapshot is read+rewritten
// once per restore — exports can be very large.
const JQ_SANITIZE_SNAPSHOT_FILTER = `${JQ_SANITIZE_TOKEN_COUNTS_FILTER} | ${JQ_SANITIZE_TRANSIENT_PARTS_FILTER}`;

function log(msg: string): void {
  const message = `restore-session: ${msg}`;
  console.error(message);
  logToFile(message);
}

function fail(
  error: string,
  code: number | null,
  step: Extract<RestoreResult, { ok: false }>['step'],
  subtype?: WorkspaceFailureSubtype,
  detail?: string
): Extract<RestoreResult, { ok: false }> {
  return {
    ok: false,
    error,
    code,
    step,
    ...(subtype ? { subtype } : {}),
    ...(detail ? { detail } : {}),
  };
}

function classifyDownloadFailure(
  callerSignal: AbortSignal | undefined,
  idleSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  idleTimeoutMs: number,
  downloadTimeoutMs: number
): Extract<RestoreResult, { ok: false }> {
  if (callerSignal?.aborted) {
    log('snapshot download aborted');
    return fail('snapshot download failed', null, 'download');
  }
  if (idleSignal.aborted) {
    log(`snapshot download stalled idleTimeoutMs=${idleTimeoutMs}`);
    return fail('snapshot download stalled', null, 'download');
  }
  if (timeoutSignal.aborted) {
    log(`snapshot download timed out timeoutMs=${downloadTimeoutMs}`);
    return fail('snapshot download timed out', null, 'download');
  }
  log('snapshot download failed');
  return fail('snapshot download failed', null, 'download');
}

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    log('cleaned up temp file');
  } catch {
    // temp file may not exist yet
  }
}

function resolveKilocodeToken(env: NodeJS.ProcessEnv): string | undefined {
  if (env.KILOCODE_TOKEN) {
    return env.KILOCODE_TOKEN;
  }

  const tokenFile = env.KILOCODE_TOKEN_FILE;
  if (!tokenFile) {
    return undefined;
  }

  return fs.readFileSync(tokenFile, 'utf8').replace(/[\r\n]+$/, '');
}

export async function seedSessionIngestRegistration(
  kiloSessionId: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if (
    kiloSessionId.length === 0 ||
    kiloSessionId.length > 128 ||
    /[^A-Za-z0-9_-]/.test(kiloSessionId)
  ) {
    throw new Error('Invalid Kilo session ID for ingest registration');
  }
  const dataHome = env.XDG_DATA_HOME;
  if (
    !dataHome ||
    !path.isAbsolute(dataHome) ||
    ['\0', '\r', '\n'].some(char => dataHome.includes(char))
  ) {
    throw new Error('Ingest registration requires an explicit absolute XDG_DATA_HOME');
  }

  const directory = path.join(dataHome, 'kilo', 'storage', 'session_share');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const temporaryPath = path.join(directory, `.${kiloSessionId}.${crypto.randomUUID()}.tmp`);
  const file = await fs.promises.open(temporaryPath, 'wx', 0o600);
  try {
    try {
      signal?.throwIfAborted();
      await fs.promises.writeFile(
        file,
        JSON.stringify({ id: kiloSessionId, ingestPath: `/api/session/${kiloSessionId}/ingest` }),
        { encoding: 'utf8', signal }
      );
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await fs.promises.rename(temporaryPath, path.join(directory, `${kiloSessionId}.json`));
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

type SnapshotInfoValidation = 'valid' | 'empty' | 'missing' | 'invalid';
type SnapshotInfoValidationResult = {
  validation: SnapshotInfoValidation;
  infoId?: string;
};

type JsonCharReader = {
  next: () => Promise<string | null>;
  unread: (char: string) => void;
  close: () => void;
};

type StreamChunkResult = {
  done?: boolean;
  value?: unknown;
};

function isStreamChunkResult(value: unknown): value is StreamChunkResult {
  return typeof value === 'object' && value !== null;
}

function createJsonCharReader(snapshotPath: string, signal?: AbortSignal): JsonCharReader {
  const stream = fs.createReadStream(snapshotPath, { encoding: 'utf8' });
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = '';
  let offset = 0;
  let unreadChar: string | undefined;

  return {
    async next(): Promise<string | null> {
      signal?.throwIfAborted();
      if (unreadChar !== undefined) {
        const char = unreadChar;
        unreadChar = undefined;
        return char;
      }

      while (offset >= buffer.length) {
        const chunk: unknown = await iterator.next();
        if (!isStreamChunkResult(chunk) || chunk.done === true) return null;
        if (typeof chunk.value !== 'string') return null;
        buffer = chunk.value;
        offset = 0;
      }

      const char = buffer[offset];
      offset += 1;
      return char ?? null;
    },
    unread(char: string): void {
      unreadChar = char;
    },
    close(): void {
      stream.destroy();
    },
  };
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

async function nextNonWhitespace(reader: JsonCharReader): Promise<string | null> {
  while (true) {
    const char = await reader.next();
    if (char === null || !isJsonWhitespace(char)) return char;
  }
}

async function readJsonString(
  reader: JsonCharReader,
  options: { collect: boolean }
): Promise<string | null> {
  let raw = '';

  while (true) {
    const char = await reader.next();
    if (char === null || char.charCodeAt(0) < 0x20) return null;
    if (char === '"') {
      if (!options.collect) return '';
      try {
        const value: unknown = JSON.parse(`"${raw}"`);
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    }
    if (char === '\\') {
      const escaped = await reader.next();
      if (escaped === null) return null;
      if ('"\\/bfnrt'.includes(escaped)) {
        if (options.collect) raw += `${char}${escaped}`;
        continue;
      }
      if (escaped !== 'u') return null;

      let unicodeEscape = `${char}${escaped}`;
      for (let digitIndex = 0; digitIndex < 4; digitIndex++) {
        const digit = await reader.next();
        if (digit === null || !/^[0-9A-Fa-f]$/.test(digit)) return null;
        unicodeEscape += digit;
      }
      if (options.collect) raw += unicodeEscape;
      continue;
    }
    if (options.collect) raw += char;
  }
}

async function skipJsonScalar(reader: JsonCharReader, firstChar: string): Promise<boolean> {
  let scalar = firstChar;
  while (true) {
    const char = await reader.next();
    if (char === null || isJsonWhitespace(char)) break;
    if (char === ',' || char === '}' || char === ']') {
      reader.unread(char);
      break;
    }
    scalar += char;
  }

  return (
    scalar === 'true' ||
    scalar === 'false' ||
    scalar === 'null' ||
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(scalar)
  );
}

async function skipJsonObject(reader: JsonCharReader): Promise<boolean> {
  const firstChar = await nextNonWhitespace(reader);
  if (firstChar === null) return false;
  if (firstChar === '}') return true;
  reader.unread(firstChar);

  while (true) {
    if ((await nextNonWhitespace(reader)) !== '"') return false;
    if ((await readJsonString(reader, { collect: false })) === null) return false;
    if ((await nextNonWhitespace(reader)) !== ':') return false;
    if (!(await skipJsonValue(reader))) return false;

    const separator = await nextNonWhitespace(reader);
    if (separator === '}') return true;
    if (separator !== ',') return false;

    const nextMember = await nextNonWhitespace(reader);
    if (nextMember === null || nextMember === '}') return false;
    reader.unread(nextMember);
  }
}

async function skipJsonArray(reader: JsonCharReader): Promise<boolean> {
  return (await validateJsonArray(reader)).ok;
}

type JsonArrayValidation = { ok: true; empty: boolean } | { ok: false };

async function validateJsonArray(reader: JsonCharReader): Promise<JsonArrayValidation> {
  const firstChar = await nextNonWhitespace(reader);
  if (firstChar === null) return { ok: false };
  if (firstChar === ']') return { ok: true, empty: true };
  reader.unread(firstChar);

  while (true) {
    if (!(await skipJsonValue(reader))) return { ok: false };

    const separator = await nextNonWhitespace(reader);
    if (separator === ']') return { ok: true, empty: false };
    if (separator !== ',') return { ok: false };

    const nextValue = await nextNonWhitespace(reader);
    if (nextValue === null || nextValue === ']') return { ok: false };
    reader.unread(nextValue);
  }
}

async function skipJsonValue(reader: JsonCharReader): Promise<boolean> {
  const firstChar = await nextNonWhitespace(reader);
  if (firstChar === null) return false;
  if (firstChar === '"') {
    return (await readJsonString(reader, { collect: false })) !== null;
  }
  if (firstChar === '{') return skipJsonObject(reader);
  if (firstChar === '[') return skipJsonArray(reader);
  return skipJsonScalar(reader, firstChar);
}

type InfoObjectValidation = { ok: true; infoId?: string; empty: boolean } | { ok: false };

async function validateInfoObject(reader: JsonCharReader): Promise<InfoObjectValidation> {
  let infoId: string | undefined;
  const firstChar = await nextNonWhitespace(reader);
  if (firstChar === null) return { ok: false };
  if (firstChar === '}') return { ok: true, empty: true };
  reader.unread(firstChar);

  while (true) {
    if ((await nextNonWhitespace(reader)) !== '"') return { ok: false };
    const key = await readJsonString(reader, { collect: true });
    if (key === null || (await nextNonWhitespace(reader)) !== ':') return { ok: false };

    if (key === 'id') {
      const idValueStart = await nextNonWhitespace(reader);
      if (idValueStart === null) return { ok: false };
      if (idValueStart === '"') {
        const nextInfoId = await readJsonString(reader, { collect: true });
        if (nextInfoId === null) return { ok: false };
        infoId = nextInfoId;
      } else {
        reader.unread(idValueStart);
        if (!(await skipJsonValue(reader))) return { ok: false };
        infoId = undefined;
      }
    } else if (!(await skipJsonValue(reader))) {
      return { ok: false };
    }

    const separator = await nextNonWhitespace(reader);
    if (separator === '}') return { ok: true, infoId, empty: false };
    if (separator !== ',') return { ok: false };

    const nextMember = await nextNonWhitespace(reader);
    if (nextMember === null || nextMember === '}') return { ok: false };
    reader.unread(nextMember);
  }
}

async function validateSnapshotInfoId(
  snapshotPath: string,
  bytesWritten: number,
  signal?: AbortSignal
): Promise<SnapshotInfoValidationResult> {
  const reader = createJsonCharReader(snapshotPath, signal);
  try {
    if ((await nextNonWhitespace(reader)) !== '{') return { validation: 'invalid' };

    let infoId: string | undefined;
    let infoIsEmpty = false;
    let messagesIsEmpty = false;
    let sessionDiffIsEmpty = false;
    let subagentsAreEmpty = true;
    let sawInfo = false;
    let sawMessages = false;
    let sawSessionDiff = false;
    let hasUnexpectedTopLevelField = false;
    const seenTopLevelFields = new Set<string>();
    const firstChar = await nextNonWhitespace(reader);
    if (firstChar === null) return { validation: 'invalid' };
    if (firstChar !== '}') {
      reader.unread(firstChar);

      while (true) {
        if ((await nextNonWhitespace(reader)) !== '"') return { validation: 'invalid' };
        const key = await readJsonString(reader, { collect: true });
        if (key === null || (await nextNonWhitespace(reader)) !== ':') {
          return { validation: 'invalid' };
        }

        if (seenTopLevelFields.has(key)) hasUnexpectedTopLevelField = true;
        seenTopLevelFields.add(key);

        if (key === 'info') {
          sawInfo = true;
          const infoStart = await nextNonWhitespace(reader);
          if (infoStart === null) return { validation: 'invalid' };
          if (infoStart === '{') {
            const infoValidation = await validateInfoObject(reader);
            if (!infoValidation.ok) return { validation: 'invalid' };
            infoId = infoValidation.infoId;
            infoIsEmpty = infoValidation.empty;
          } else {
            reader.unread(infoStart);
            if (!(await skipJsonValue(reader))) return { validation: 'invalid' };
            infoId = undefined;
            infoIsEmpty = false;
          }
        } else if (key === 'messages' || key === 'sessionDiff' || key === 'subagents') {
          const valueStart = await nextNonWhitespace(reader);
          if (valueStart === null) return { validation: 'invalid' };
          let valueIsEmpty = false;
          if (valueStart === '[') {
            const arrayValidation = await validateJsonArray(reader);
            if (!arrayValidation.ok) return { validation: 'invalid' };
            valueIsEmpty = arrayValidation.empty;
          } else {
            reader.unread(valueStart);
            if (!(await skipJsonValue(reader))) return { validation: 'invalid' };
          }

          if (key === 'messages') {
            sawMessages = true;
            messagesIsEmpty = valueIsEmpty;
          } else if (key === 'sessionDiff') {
            sawSessionDiff = true;
            sessionDiffIsEmpty = valueIsEmpty;
          } else {
            subagentsAreEmpty = valueIsEmpty;
          }
        } else if (!(await skipJsonValue(reader))) {
          return { validation: 'invalid' };
        } else {
          hasUnexpectedTopLevelField = true;
        }

        const separator = await nextNonWhitespace(reader);
        if (separator === '}') break;
        if (separator !== ',') return { validation: 'invalid' };

        const nextMember = await nextNonWhitespace(reader);
        if (nextMember === null || nextMember === '}') return { validation: 'invalid' };
        reader.unread(nextMember);
      }
    }

    if ((await nextNonWhitespace(reader)) !== null) return { validation: 'invalid' };
    if (
      bytesWritten <= MAX_EMPTY_SNAPSHOT_BYTES &&
      infoId === undefined &&
      sawInfo &&
      sawMessages &&
      sawSessionDiff &&
      infoIsEmpty &&
      messagesIsEmpty &&
      sessionDiffIsEmpty &&
      subagentsAreEmpty &&
      !hasUnexpectedTopLevelField
    ) {
      return { validation: 'empty' };
    }
    return infoId === undefined ? { validation: 'missing' } : { validation: 'valid', infoId };
  } finally {
    reader.close();
  }
}

function tokenSanitizationTempPath(snapshotPath: string): string {
  return path.join(
    path.dirname(snapshotPath),
    `.kilo-sanitized-${path.basename(snapshotPath)}-${process.pid}-${Date.now()}`
  );
}

async function sanitizeSnapshotWithJq(
  snapshotPath: string,
  filter: string,
  logLabel: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  const tempPath = tokenSanitizationTempPath(snapshotPath);
  try {
    signal?.throwIfAborted();
    const proc = Bun.spawn(['jq', '-c', filter, snapshotPath], {
      stdout: 'pipe',
      stderr: 'ignore',
      signal,
      env,
    });
    const writeOutput = proc.stdout.pipeTo(Writable.toWeb(fs.createWriteStream(tempPath)));
    const exitCode = await proc.exited;
    await writeOutput;
    signal?.throwIfAborted();
    if (exitCode !== 0) {
      log(`snapshot_${logLabel}_jq_unavailable exitCode=${exitCode}`);
      return false;
    }
    fs.renameSync(tempPath, snapshotPath);
    return true;
  } catch {
    signal?.throwIfAborted();
    log(`snapshot_${logLabel}_jq_unavailable`);
    return false;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

async function sanitizeSnapshot(
  snapshotPath: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  if (
    await sanitizeSnapshotWithJq(
      snapshotPath,
      JQ_SANITIZE_SNAPSHOT_FILTER,
      'sanitization',
      signal,
      env
    )
  ) {
    log('snapshot sanitized');
    return;
  }
  log('snapshot sanitization skipped');
}

// jq filter that extracts diffs from the snapshot JSON using last-write-wins
// deduplication by file path. Runs as a subprocess so the full parsed snapshot
// is never loaded into the main process's heap — jq's C-native parser uses
// ~half the memory of a V8 heap.
// `objects` filters out non-object .summary values (e.g. compaction messages set summary=true)
const JQ_EXTRACT_DIFFS_FILTER =
  'reduce (if ((.sessionDiff? // []) | length) > 0 then .sessionDiff[] else (.messages[]?.info.summary | objects | .diffs[]? // empty) end) as $d ({}; if (($d.file? | type) == "string") then .[$d.file] = $d else . end) | [.[]]';

/**
 * Extract last-write-wins diffs from a snapshot file. Prefers a jq subprocess
 * (memory-efficient — the parsed snapshot stays in C-native heap) and falls
 * back to bun-native parsing when jq isn't on PATH. The fallback matters for
 * the devcontainer flow: the user's image is only required to ship `node` +
 * `bun`, so `jq` may be missing.
 */
export async function extractDiffs(
  snapshotPath: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<SnapshotDiff[] | null> {
  signal?.throwIfAborted();
  try {
    const proc = Bun.spawn(['jq', '-c', JQ_EXTRACT_DIFFS_FILTER, snapshotPath], {
      stdout: 'pipe',
      stderr: 'ignore',
      signal,
      env,
    });
    const exitCode = await proc.exited;
    signal?.throwIfAborted();
    if (exitCode === 0) {
      const stdout = await new Response(proc.stdout).text();
      try {
        return JSON.parse(stdout) as SnapshotDiff[];
      } catch {
        log('jq_output_invalid');
        return null;
      }
    }
    log(`jq_unavailable exitCode=${exitCode}`);
  } catch {
    signal?.throwIfAborted();
    log('jq_unavailable');
  }

  return extractDiffsWithBun(snapshotPath, signal);
}

/**
 * In-process fallback for environments without `jq`. Loads the whole snapshot
 * into the V8 heap and applies the same last-write-wins dedup the jq filter
 * does. Higher peak memory than jq but avoids a hard dependency.
 */
async function extractDiffsWithBun(
  snapshotPath: string,
  signal?: AbortSignal
): Promise<SnapshotDiff[] | null> {
  type SnapshotShape = {
    sessionDiff?: SnapshotDiff[];
    messages?: Array<{
      info?: {
        summary?: { diffs?: SnapshotDiff[] };
      };
    }>;
  };
  let parsed: SnapshotShape;
  try {
    signal?.throwIfAborted();
    parsed = (await Bun.file(snapshotPath).json()) as SnapshotShape;
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    log('snapshot_parse_failed');
    return null;
  }
  const dedup = new Map<string, SnapshotDiff>();
  if (Array.isArray(parsed.sessionDiff) && parsed.sessionDiff.length > 0) {
    for (const diff of parsed.sessionDiff) {
      if (diff && typeof diff.file === 'string') dedup.set(diff.file, diff);
    }
    return Array.from(dedup.values());
  }
  for (const message of parsed.messages ?? []) {
    const summary = message?.info?.summary;
    if (!summary || typeof summary !== 'object') continue;
    for (const diff of summary.diffs ?? []) {
      if (diff && typeof diff.file === 'string') dedup.set(diff.file, diff);
    }
  }
  return Array.from(dedup.values());
}

async function runGitApply(
  workspacePath: string,
  patchFile: string,
  extraArgs: string[],
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['git', 'apply', ...extraArgs, '--whitespace=nowarn', patchFile], {
    cwd: workspacePath,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    env,
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr: stderr.trim() };
}

function describePatch(patch: string): string {
  const eofMarkers = patch.match(/^\\ No newline at end of file(?:\r?\n|$)/gm)?.length ?? 0;
  const absoluteHeaders =
    (patch.match(/^(?:Index: |--- |\+\+\+ )\//gm)?.length ?? 0) +
    (patch.match(/^diff --git \//gm)?.length ?? 0);

  return [
    `sha256=${createHash('sha256').update(patch).digest('hex')}`,
    `bytes=${Buffer.byteLength(patch, 'utf8')}`,
    `finalNewline=${patch.endsWith('\n')}`,
    `eofMarkers=${eofMarkers}`,
    `hunkHeaders=${patch.match(/^@@ /gm)?.length ?? 0}`,
    `absoluteHeaders=${absoluteHeaders}`,
  ].join(' ');
}

function logPatchMetadata(file: string, phase: 'raw' | 'normalized', patch: string): void {
  log(`patch metadata file=${file} phase=${phase} ${describePatch(patch)}`);
}

function resolveWorkspaceRelativePath(workspacePath: string, file: string): string | null {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedFile = path.resolve(resolvedWorkspace, file);
  const relativeFile = path.relative(resolvedWorkspace, resolvedFile);
  const normalizedFile = relativeFile.split(path.sep).join('/');

  if (
    normalizedFile.length === 0 ||
    normalizedFile === '..' ||
    normalizedFile.startsWith('../') ||
    path.isAbsolute(relativeFile)
  ) {
    return null;
  }

  return normalizedFile;
}

type NormalizedPatch =
  | { ok: true; patch: string }
  | { ok: false; reason: Extract<RestoreSkipReason, 'missing_content' | 'outside_workspace'> };

function normalizePatchForWorkspace(workspacePath: string, diff: SnapshotDiff): NormalizedPatch {
  if (!diff.patch) return { ok: false, reason: 'missing_content' };

  const relativeFile = resolveWorkspaceRelativePath(workspacePath, diff.file);
  if (!relativeFile) {
    log(`skipping patch outside workspace file=${diff.file}`);
    return { ok: false, reason: 'outside_workspace' };
  }

  logPatchMetadata(relativeFile, 'raw', diff.patch);

  // Kilo's session.diff patches use absolute sandbox paths. Git treats those
  // as patch pathnames, not filesystem paths, so rewrite every patch header to
  // the workspace-relative file before applying it.
  const normalizedPatch = diff.patch
    .replace(/^diff --git [^\r\n]*$/m, `diff --git a/${relativeFile} b/${relativeFile}`)
    .replace(/^Index: [^\r\n]*$/m, `Index: ${relativeFile}`)
    .replace(/^--- [^\r\n]*$/m, `--- a/${relativeFile}`)
    .replace(/^\+\+\+ [^\r\n]*$/m, `+++ b/${relativeFile}`);

  if (normalizedPatch !== diff.patch) {
    log(`normalized patch paths file=${relativeFile}`);
    logPatchMetadata(relativeFile, 'normalized', normalizedPatch);
  }

  return { ok: true, patch: normalizedPatch };
}

async function logGitPatchDiagnostics(
  workspacePath: string,
  patchFile: string,
  file: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const checks: Array<{ mode: string; args: string[] }> = [
    { mode: 'stat', args: ['--stat'] },
    { mode: 'recount-stat', args: ['--recount', '--stat'] },
    { mode: 'check', args: ['--check'] },
    { mode: 'recount-check', args: ['--recount', '--check'] },
  ];

  for (const check of checks) {
    const result = await runGitApply(workspacePath, patchFile, check.args, signal, env);
    const stderr = result.stderr.replace(/\s+/g, ' ').slice(0, 512);
    log(
      `git patch diagnostic file=${file} mode=${check.mode} exitCode=${result.exitCode}${stderr ? ` stderr=${stderr}` : ''}`
    );
  }
}

type PatchApplyOutcome = { applied: true } | { applied: false; reason: RestoreSkipReason };

async function applyPatch(
  workspacePath: string,
  diff: SnapshotDiff,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<PatchApplyOutcome> {
  const normalized = normalizePatchForWorkspace(workspacePath, diff);
  if (!normalized.ok) return { applied: false, reason: normalized.reason };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-session-diff-'));
  const file = path.join(dir, 'change.patch');
  try {
    signal?.throwIfAborted();
    fs.writeFileSync(file, normalized.patch);
    const threeWay = await runGitApply(workspacePath, file, ['--3way'], signal, env);
    signal?.throwIfAborted();
    if (threeWay.exitCode === 0) return { applied: true };
    log(
      `git apply --3way failed file=${diff.file} exitCode=${threeWay.exitCode}${threeWay.stderr ? ` stderr=${threeWay.stderr}` : ''}`
    );

    // A failed three-way apply can leave unmerged index entries. Reset the
    // index before trying fallbacks, while preserving restored working-tree files.
    const reset = Bun.spawn(['git', 'reset', '--quiet'], {
      cwd: workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      env,
    });
    const resetStderr = await new Response(reset.stderr).text();
    const resetExitCode = await reset.exited;
    signal?.throwIfAborted();
    if (resetExitCode !== 0) {
      log(
        `failed to clear three-way apply state file=${diff.file} exitCode=${resetExitCode}${resetStderr.trim() ? ` stderr=${resetStderr.trim()}` : ''}`
      );
      return { applied: false, reason: 'index_reset_failed' };
    }

    await logGitPatchDiagnostics(workspacePath, file, diff.file, signal, env);

    const plain = await runGitApply(workspacePath, file, [], signal, env);
    signal?.throwIfAborted();
    if (plain.exitCode === 0) {
      log(`git apply fallback succeeded file=${diff.file}`);
      return { applied: true };
    }
    log(
      `git apply fallback failed file=${diff.file} exitCode=${plain.exitCode}${plain.stderr ? ` stderr=${plain.stderr}` : ''}`
    );

    if (diff.status === 'deleted') {
      const resolvedWorkspace = path.resolve(workspacePath);
      const fp = path.resolve(resolvedWorkspace, diff.file);
      if (!fp.startsWith(resolvedWorkspace + '/')) {
        log(`skipping deleted-file unlink outside workspace file=${fp}`);
        return { applied: false, reason: 'outside_workspace' };
      }
      try {
        fs.unlinkSync(fp);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`failed to unlink deleted file=${diff.file}`);
          return { applied: false, reason: 'unlink_failed' };
        }
      }
      log(`unlinked deleted file after failed patch file=${diff.file}`);
      return { applied: true };
    }

    if (diff.after !== undefined) {
      const resolvedWorkspace = path.resolve(workspacePath);
      const fp = path.resolve(resolvedWorkspace, diff.file);
      if (!fp.startsWith(resolvedWorkspace + '/')) {
        log(`skipping after-content write outside workspace file=${fp}`);
        return { applied: false, reason: 'outside_workspace' };
      }
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, diff.after);
      } catch {
        log(`failed to write snapshot after-content file=${diff.file}`);
        return { applied: false, reason: 'write_failed' };
      }
      log(`wrote snapshot after-content file=${diff.file}`);
      return { applied: true };
    }
    return { applied: false, reason: 'patch_apply_failed' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type SnapshotDownloadOutcome =
  | { outcome: 'ok'; bytesWritten: number }
  | { outcome: 'aborted' }
  | { outcome: 'over-cap' };

type SnapshotChunk = { done: false; value: Uint8Array } | { done: true; value?: undefined };

async function readSnapshotChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  aborted: Promise<'aborted'>
): Promise<SnapshotChunk | 'aborted'> {
  const read = reader.read();
  if (signal.aborted) {
    read.catch(() => {});
    void reader.cancel().catch(() => {});
    return 'aborted';
  }

  const result = await Promise.race([read, aborted]);
  // Abort is authoritative: a cancel can fulfil the pending read with
  // `{ done: true }` before the abort sentinel wins the race, and accepting
  // that EOF would resume validation on a truncated body.
  if (signal.aborted) {
    read.catch(() => {});
    void reader.cancel().catch(() => {});
    return 'aborted';
  }
  return result;
}

async function downloadSnapshotToFile(
  tmpPath: string,
  body: ReadableStream<Uint8Array> | null,
  declaredContentLength: number | null,
  signal: AbortSignal,
  aborted: Promise<'aborted'>,
  maxSnapshotBytes: number,
  restartIdle: () => void
): Promise<SnapshotDownloadOutcome> {
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;

  if (!body) {
    const empty = await fs.promises.open(tmpPath, flags, 0o600);
    await empty.close();
    return { outcome: 'ok', bytesWritten: 0 };
  }

  if (declaredContentLength !== null && declaredContentLength > maxSnapshotBytes) {
    log(
      `snapshot download failed reason=content_length bytes=${declaredContentLength} cap=${maxSnapshotBytes}`
    );
    void body.cancel().catch(() => {});
    return { outcome: 'over-cap' };
  }

  const handle = await fs.promises.open(tmpPath, flags, 0o600);
  const reader = body.getReader();
  let bytesWritten = 0;
  try {
    while (true) {
      const chunk = await readSnapshotChunk(reader, signal, aborted);
      if (chunk === 'aborted') return { outcome: 'aborted' };
      if (chunk.done) break;
      if (!chunk.value || chunk.value.byteLength === 0) {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 0);
        });
        if (signal.aborted) return { outcome: 'aborted' };
        continue;
      }

      const nextBytes = bytesWritten + chunk.value.byteLength;
      if (nextBytes > maxSnapshotBytes) {
        log(
          `snapshot download failed reason=streamed_bytes bytes=${nextBytes} cap=${maxSnapshotBytes}`
        );
        void reader.cancel().catch(() => {});
        return { outcome: 'over-cap' };
      }

      restartIdle();
      let pending = chunk.value;
      while (pending.byteLength > 0) {
        const write = handle.write(pending);
        write.catch(() => {});
        const written = await Promise.race([
          write.then(result => result.bytesWritten),
          aborted.then(() => 'aborted' as const),
        ]);
        if (written === 'aborted' || signal.aborted) return { outcome: 'aborted' };
        if (written === 0) throw new Error('snapshot write made no progress');
        pending = pending.subarray(written);
      }
      bytesWritten = nextBytes;
    }
    return { outcome: 'ok', bytesWritten };
  } finally {
    void reader.cancel().catch(() => {});
    await handle.close();
  }
}

export async function restoreSession(
  kiloSessionId: string,
  workspacePath: string,
  filePath?: string,
  options: RestoreSessionOptions = {}
): Promise<RestoreResult> {
  let tmpPath = filePath;
  let tempDir: string | undefined;
  if (!tmpPath) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-session-export-'));
    tmpPath = path.join(tempDir, 'snapshot.json');
  }
  const downloaded = !filePath;
  const importTimeoutMs = options.importTimeoutMs ?? KILO_IMPORT_TIMEOUT_MS;
  const env = options.env ?? process.env;

  try {
    log(
      `starting kiloSessionId=${kiloSessionId} workspace=${workspacePath} input=${downloaded ? 'downloaded' : 'provided'} tmpPath=${tmpPath} home=${env.HOME ?? '(unset)'}`
    );

    if (!filePath) {
      const ingestUrl = env.KILO_SESSION_INGEST_URL;
      let token: string | undefined;
      try {
        token = resolveKilocodeToken(env);
      } catch {
        return fail('failed to read KILOCODE_TOKEN_FILE', null, 'download');
      }

      if (!ingestUrl || !token) {
        const missing = [!ingestUrl && 'KILO_SESSION_INGEST_URL', !token && 'KILOCODE_TOKEN']
          .filter(Boolean)
          .join(', ');
        return fail(`missing env vars: ${missing}`, null, 'download');
      }

      log(`ingestUrl=${ingestUrl}`);

      log('downloading snapshot');
      const downloadTimeoutMs = options.downloadTimeoutMs ?? KILO_DOWNLOAD_TIMEOUT_MS;
      const idleTimeoutMs = options.idleTimeoutMs ?? KILO_DOWNLOAD_IDLE_TIMEOUT_MS;
      const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_SESSION_EXPORT_BYTES;
      const downloadTimeoutSignal = AbortSignal.timeout(downloadTimeoutMs);
      const idleController = new AbortController();
      const idle = Promise.withResolvers<'idle'>();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const restartIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idle.resolve('idle');
          idleController.abort();
        }, idleTimeoutMs);
      };
      const downloadSignal = AbortSignal.any(
        options.signal
          ? [options.signal, downloadTimeoutSignal, idleController.signal]
          : [downloadTimeoutSignal, idleController.signal]
      );
      const downloadAbort = Promise.withResolvers<'aborted'>();
      const onDownloadAbort = (): void => downloadAbort.resolve('aborted');
      if (downloadSignal.aborted) {
        downloadAbort.resolve('aborted');
      } else {
        downloadSignal.addEventListener('abort', onDownloadAbort, { once: true });
      }
      restartIdle();
      try {
        const url = `${ingestUrl}/api/session/${encodeURIComponent(kiloSessionId)}/export`;
        const res = await Promise.race([
          fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: downloadSignal,
          }),
          idle.promise,
          downloadAbort.promise,
        ]);
        if (res === 'idle' || res === 'aborted') {
          return classifyDownloadFailure(
            options.signal,
            idleController.signal,
            downloadTimeoutSignal,
            idleTimeoutMs,
            downloadTimeoutMs
          );
        }
        restartIdle();

        if (!res.ok) {
          if (res.status === 404) {
            log('snapshot not found (404)');
            return fail('snapshot not found (404)', 404, 'download');
          }
          log(`download failed status=${res.status}`);
          return fail(`download failed status=${res.status}`, 502, 'download');
        }

        const contentLengthHeader = res.headers.get('content-length');
        const declaredContentLength =
          contentLengthHeader === null ? null : Number(contentLengthHeader);
        const download = await downloadSnapshotToFile(
          tmpPath,
          res.body,
          declaredContentLength !== null && Number.isFinite(declaredContentLength)
            ? declaredContentLength
            : null,
          downloadSignal,
          downloadAbort.promise,
          maxSnapshotBytes,
          restartIdle
        );
        if (download.outcome === 'over-cap') {
          return fail('snapshot exceeded byte cap', null, 'download');
        }
        if (download.outcome === 'aborted') {
          return classifyDownloadFailure(
            options.signal,
            idleController.signal,
            downloadTimeoutSignal,
            idleTimeoutMs,
            downloadTimeoutMs
          );
        }

        const bytesWritten = download.bytesWritten;
        log(`snapshot downloaded bytes=${bytesWritten}`);

        // Validate before handing off to `kilo import`: an upstream error
        // surface (e.g. a JSON `{"detail":"..."}` body served as 200) crashes
        // kilo with a cryptic `undefined is not an object (evaluating 'info2.id')`
        // and exit 1. Stream only the top-level metadata guardrail instead of
        // materializing the full export in the wrapper heap.
        const snapshotInfoValidation = await validateSnapshotInfoId(
          tmpPath,
          bytesWritten,
          options.signal
        );
        log(
          `snapshot metadata validated status=${snapshotInfoValidation.validation} expectedKiloSessionId=${kiloSessionId} snapshotInfoId=${snapshotInfoValidation.infoId ?? '(missing)'} idMatchesExpected=${snapshotInfoValidation.infoId === kiloSessionId} bytes=${bytesWritten}`
        );
        if (snapshotInfoValidation.validation === 'invalid') {
          log('snapshot is not valid JSON before info.id metadata');
          return fail(`snapshot is not valid JSON (${bytesWritten} bytes)`, null, 'download');
        }
        if (snapshotInfoValidation.validation === 'empty') {
          log('snapshot is an empty session export; treating it as not found');
          return fail('snapshot not found (404)', 404, 'download');
        }
        if (snapshotInfoValidation.validation === 'missing') {
          const result = fail(
            `snapshot missing info.id (${bytesWritten} bytes); session-ingest may have returned an error body`,
            null,
            'download'
          );
          if (
            bytesWritten === EMPTY_SESSION_INGEST_EXPORT.length &&
            (await Bun.file(tmpPath).text()) === EMPTY_SESSION_INGEST_EXPORT
          ) {
            log('snapshot contains no session metadata or history');
            return { ...result, emptySnapshot: true };
          }
          log('snapshot missing info.id — likely an error response');
          return result;
        }
      } catch {
        return classifyDownloadFailure(
          options.signal,
          idleController.signal,
          downloadTimeoutSignal,
          idleTimeoutMs,
          downloadTimeoutMs
        );
      } finally {
        downloadSignal.removeEventListener('abort', onDownloadAbort);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      }
    } else {
      log(`using provided file=${filePath}`);
      try {
        const providedInfoValidation = await validateSnapshotInfoId(
          tmpPath,
          fs.statSync(tmpPath).size,
          options.signal
        );
        log(
          `provided snapshot metadata inspected status=${providedInfoValidation.validation} expectedKiloSessionId=${kiloSessionId} snapshotInfoId=${providedInfoValidation.infoId ?? '(missing)'} idMatchesExpected=${providedInfoValidation.infoId === kiloSessionId}`
        );
      } catch {
        options.signal?.throwIfAborted();
        log(`provided snapshot metadata inspection failed expectedKiloSessionId=${kiloSessionId}`);
      }
    }

    await sanitizeSnapshot(tmpPath, options.signal, env);

    const importStartedAt = Date.now();
    log(
      `running kilo import kiloSessionId=${kiloSessionId} input=${downloaded ? 'downloaded' : 'provided'} cwd=${workspacePath} home=${env.HOME ?? '(unset)'} tmpPath=${tmpPath}`
    );
    const importResult = await runProcess('kilo', ['import', tmpPath], {
      cwd: workspacePath,
      env,
      inheritEnv: false,
      timeoutMs: importTimeoutMs,
      signal: options.signal,
      terminationGraceMs: options.importTerminationGraceMs,
    });
    const importElapsedMs = Date.now() - importStartedAt;

    if (isTimeoutTermination(importResult)) {
      log(
        `kilo import finished outcome=timeout kiloSessionId=${kiloSessionId} input=${downloaded ? 'downloaded' : 'provided'} cwd=${workspacePath} home=${env.HOME ?? '(unset)'} elapsedMs=${importElapsedMs} timeoutMs=${importTimeoutMs}`
      );
      return fail(
        `kilo import timed out after ${importTimeoutMs}ms`,
        null,
        'import',
        'kilo_import_timeout',
        createSafeProcessDiagnostic(importResult)
      );
    }

    if (importResult.exitCode !== 0) {
      log(
        `kilo import finished outcome=error exitCode=${importResult.exitCode} kiloSessionId=${kiloSessionId} input=${downloaded ? 'downloaded' : 'provided'} cwd=${workspacePath} home=${env.HOME ?? '(unset)'} elapsedMs=${importElapsedMs}`
      );
      return fail(
        `kilo import failed exitCode=${importResult.exitCode}`,
        null,
        'import',
        'kilo_import_failed',
        createSafeProcessDiagnostic(importResult)
      );
    }
    log(
      `kilo import finished outcome=ok exitCode=${importResult.exitCode} kiloSessionId=${kiloSessionId} input=${downloaded ? 'downloaded' : 'provided'} cwd=${workspacePath} home=${env.HOME ?? '(unset)'} elapsedMs=${importElapsedMs}`
    );

    // Extract diffs in a subprocess so the full snapshot JSON is never loaded
    // into this process's heap — only the small diff array crosses the boundary.
    const uniqueDiffs = await extractDiffs(tmpPath, options.signal, env);
    if (uniqueDiffs === null) {
      return fail('failed to parse snapshot JSON', null, 'diffs');
    }
    const total = uniqueDiffs.length;

    if (total === 0) {
      log('no diffs to apply');
      return {
        ok: true,
        downloaded,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      };
    }

    log(`found ${total} unique file diffs`);

    const resolvedWorkspace = path.resolve(workspacePath);
    let applied = 0;
    let skipped = 0;
    const skippedDiffs: RestoreDiffSkip[] = [];
    // First-seen skip reason -> the first path that carried it. The record cap
    // below bounds the telemetry frame, but a reason that the first 100 skips do
    // not carry must still reach `buildRestoreIncompleteReport`; remembering one
    // path per reason (a small closed set) lets the post-pass restore it.
    const firstPathForReason = new Map<RestoreSkipReason, string>();
    const recordSkip = (file: string, reason: RestoreSkipReason): void => {
      if (!firstPathForReason.has(reason)) firstPathForReason.set(reason, file);
      if (skippedDiffs.length < MAX_RECORDED_SKIPPED_DIFFS) {
        skippedDiffs.push({ file, reason });
      }
    };

    for (const diff of uniqueDiffs) {
      options.signal?.throwIfAborted();
      if (diff.patch) {
        try {
          const outcome = await applyPatch(workspacePath, diff, options.signal, env);
          if (outcome.applied) {
            applied++;
          } else {
            recordSkip(diff.file, outcome.reason);
            skipped++;
          }
        } catch (err) {
          if (options.signal?.aborted) throw err;
          log(`failed to apply patch file=${diff.file}`);
          recordSkip(diff.file, 'patch_apply_failed');
          skipped++;
        }
        continue;
      }

      const fp = path.resolve(resolvedWorkspace, diff.file);

      if (!fp.startsWith(resolvedWorkspace + '/')) {
        log(`skipping diff outside workspace file=${fp}`);
        recordSkip(diff.file, 'outside_workspace');
        skipped++;
        continue;
      }

      if (diff.status === 'deleted') {
        try {
          fs.unlinkSync(fp);
          applied++;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            applied++;
          } else {
            log(`failed to unlink diff file=${fp}`);
            recordSkip(diff.file, 'unlink_failed');
            skipped++;
          }
        }
      } else if (diff.after !== undefined) {
        try {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, diff.after);
          applied++;
        } catch {
          log(`failed to apply diff file=${fp}`);
          recordSkip(diff.file, 'write_failed');
          skipped++;
        }
      } else {
        recordSkip(diff.file, 'missing_content');
        skipped++;
      }
    }

    log(`diffs applied=${applied} skipped=${skipped} total=${total}`);
    if (skipped > 0) {
      // A skipped diff does not fail the restore: the worktree keeps whatever
      // applied, and the named reasons above are the report. Do NOT retry the
      // whole restore — a blind re-run is the defect this replaced. A targeted
      // retry acts on the recorded reasons and paths instead.
      log('restore incomplete; continuing with partially restored workspace');
    } else {
      log('completed successfully');
    }

    // Keep every distinct skip reason inside the record cap: reserve one record
    // for a reason the first 100 skips did not carry, so the report cannot
    // understate the reasons. A reserved record reuses that reason's first path.
    const retainedReasons = new Set(skippedDiffs.map(entry => entry.reason));
    const missingReasons = [...firstPathForReason.keys()].filter(
      reason => !retainedReasons.has(reason)
    );
    if (missingReasons.length > 0) {
      skippedDiffs.length = Math.max(0, MAX_RECORDED_SKIPPED_DIFFS - missingReasons.length);
      for (const reason of missingReasons) {
        skippedDiffs.push({ file: firstPathForReason.get(reason) ?? '', reason });
      }
    }

    const diffs: {
      applied: number;
      skipped: number;
      total: number;
      skippedDiffs?: RestoreDiffSkip[];
    } = { applied, skipped, total };
    if (skipped > 0) {
      diffs.skippedDiffs = skippedDiffs;
    }
    return { ok: true, downloaded, imported: true, diffs };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      tryUnlink(tmpPath);
    }
  }
}

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  let filePath: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--file') {
      filePath = rawArgs[++i];
    } else {
      positional.push(rawArgs[i]);
    }
  }

  const [kiloSessionId, workspacePath] = positional;
  if (!kiloSessionId || !workspacePath) {
    console.log(
      JSON.stringify({
        ok: false,
        error: 'Usage: kilo-restore-session [--file <path>] <kiloSessionId> <workspacePath>',
        code: null,
        step: 'download',
      })
    );
    process.exit(1);
  }
  void restoreSession(kiloSessionId, workspacePath, filePath).then(result => {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  });
}
