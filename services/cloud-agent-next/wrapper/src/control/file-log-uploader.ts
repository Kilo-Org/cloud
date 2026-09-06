import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_LOG_ARCHIVE_NAME,
  CONTROL_LOG_MAX_ARCHIVE_BYTES,
  type ControlDiagnosticReporter,
  type ControlLogUploadResult,
} from '../../../src/shared/control-diagnostics.js';
import { createTarStream, type TarArchiveEntry } from '../log-uploader.js';
import { logToFile, withTimeoutAndAbort } from '../utils.js';

export type ControlFileLogUploader = {
  start: (intervalMs?: number) => void;
  uploadNow: () => Promise<void>;
  finalize: (timeoutMs?: number) => Promise<void>;
  stop: () => void;
};

type Options = {
  uploadUrl?: string;
  uploadGrant?: string;
  wrapperLogPath?: string;
  homeRoot?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  onDiagnostic?: ControlDiagnosticReporter;
  intervalMs?: number;
  uploadTimeoutMs?: number;
};

const KILO_LOG_RELATIVE = path.join('.local', 'share', 'kilo', 'log');
const DEFAULT_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';
const UPLOAD_TIMEOUT_MS = 15_000;
const FINAL_UPLOAD_TIMEOUT_MS = 5_000;
const INTERVAL_MS = 30_000;

export function defaultControlWorktreeHomeRoot(): string {
  return path.join(os.tmpdir(), 'kilo-worktrees');
}

export function listControlKiloLogDirs(homeRoot = defaultControlWorktreeHomeRoot()): string[] {
  if (!existsSync(homeRoot)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(homeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const logDir = path.join(homeRoot, entry.name, KILO_LOG_RELATIVE);
    if (existsSync(logDir)) dirs.push(logDir);
  }
  return dirs;
}

export function selectControlFileLogPaths(input: {
  wrapperLogPath: string;
  kiloLogDirs: string[];
  maxBytes?: number;
}): string[] {
  const maxBytes = input.maxBytes ?? CONTROL_LOG_MAX_ARCHIVE_BYTES;
  const selected: string[] = [];
  let used = 0;
  const add = (filePath: string, size: number): void => {
    if (size > maxBytes - used) return;
    selected.push(filePath);
    used += size;
  };
  if (existsSync(input.wrapperLogPath)) {
    const st = statSync(input.wrapperLogPath);
    if (st.isFile()) add(input.wrapperLogPath, st.size);
  }
  const kiloFiles: Array<{ path: string; size: number; mtime: number }> = [];
  for (const dir of input.kiloLogDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const filePath = path.join(dir, entry.name);
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      kiloFiles.push({ path: filePath, size: st.size, mtime: st.mtimeMs });
    }
  }
  kiloFiles.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  for (const file of kiloFiles) add(file.path, file.size);
  return selected;
}

function archiveEntries(
  files: string[],
  wrapperLogPath: string,
  homeRoot: string
): TarArchiveEntry[] {
  const entries: TarArchiveEntry[] = [];
  for (const filePath of files) {
    if (filePath === wrapperLogPath) {
      entries.push({ directory: path.dirname(filePath), name: path.basename(filePath) });
      continue;
    }
    const relative = path.relative(homeRoot, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    entries.push({ directory: homeRoot, name: relative });
  }
  return entries;
}

async function collectArchive(
  entries: TarArchiveEntry[],
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const tar = createTarStream(entries);
  if (!tar) return undefined;
  try {
    const reader = tar.stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        tar.kill();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    tar.kill();
  }
}

export function createControlFileLogUploader(options: Options): ControlFileLogUploader {
  type Upload = { promise: Promise<void>; abort: AbortController };
  const upload = options.fetch ?? fetch;
  const wrapperLogPath = options.wrapperLogPath ?? DEFAULT_WRAPPER_LOG_PATH;
  const homeRoot = options.homeRoot ?? defaultControlWorktreeHomeRoot();
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let activeUpload: Upload | undefined;
  let queuedUpload: Upload | undefined;
  let finalUpload: Promise<void> | undefined;
  let stopped = false;

  function reportFailure(category: ControlLogUploadResult, statusCode?: number): void {
    try {
      options.onDiagnostic?.('control.upload', {
        phase: 'failed',
        category,
        statusCode:
          statusCode !== undefined && statusCode >= 100 && statusCode <= 599
            ? statusCode
            : undefined,
      });
    } catch {
      return;
    }
  }

  function uploadNow(): Promise<void> {
    if (finalUpload) return finalUpload;
    if (stopped) return Promise.resolve();
    if (queuedUpload) return queuedUpload.promise;
    const uploadUrl = options.uploadUrl;
    const uploadGrant = options.uploadGrant;
    if (!uploadUrl || !uploadGrant) return Promise.resolve();
    const archiveUrl = `${uploadUrl.replace(/\/$/, '')}/${CONTROL_LOG_ARCHIVE_NAME}`;
    const authorization = `Bearer ${uploadGrant}`;

    const previousUpload = activeUpload;
    const abort = new AbortController();
    const next: Upload = { promise: performUpload(), abort };
    if (previousUpload) queuedUpload = next;
    else activeUpload = next;
    return next.promise;

    async function performUpload(): Promise<void> {
      try {
        await withTimeoutAndAbort(
          (async () => {
            await previousUpload?.promise;
            abort.signal.throwIfAborted();
            if (queuedUpload === next) queuedUpload = undefined;
            activeUpload = next;

            const files = selectControlFileLogPaths({
              wrapperLogPath,
              kiloLogDirs: listControlKiloLogDirs(homeRoot),
            });
            const entries = archiveEntries(files, wrapperLogPath, homeRoot);
            if (entries.length === 0) return;
            const body = await collectArchive(entries, CONTROL_LOG_MAX_ARCHIVE_BYTES);
            abort.signal.throwIfAborted();
            if (!body) {
              logToFile('Control file log archive exceeded the upload cap');
              return;
            }

            const payload = new ArrayBuffer(body.byteLength);
            new Uint8Array(payload).set(body);
            const response = await upload(archiveUrl, {
              method: 'PUT',
              headers: {
                Authorization: authorization,
                'Content-Type': 'application/gzip',
                'Content-Length': String(payload.byteLength),
              },
              body: payload,
              redirect: 'error',
              signal: abort.signal,
            });
            if (!abort.signal.aborted && response.status !== 204) {
              logToFile(`Control file log upload failed: ${response.status}`);
              reportFailure('http_rejection', response.status);
            }
            void response.body?.cancel().catch(() => undefined);
          })(),
          {
            timeoutMs: options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
            timeoutMessage: 'Control file log upload timed out',
            signal: abort.signal,
            abortMessage: 'Control file log upload aborted',
          }
        );
      } catch (error) {
        if (stopped || abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : '';
        reportFailure(message.includes('timed out') ? 'timeout' : 'network_failure');
        logToFile('Control file log upload did not complete');
      } finally {
        abort.abort();
        if (activeUpload === next) activeUpload = undefined;
        if (queuedUpload === next) queuedUpload = undefined;
      }
    }
  }

  function clearUploadInterval(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }

  function start(intervalMs = options.intervalMs ?? INTERVAL_MS): void {
    stop();
    stopped = false;
    finalUpload = undefined;
    if (!options.uploadUrl || !options.uploadGrant) return;
    void uploadNow();
    intervalId = setInterval(() => {
      if (!activeUpload && !queuedUpload) void uploadNow();
    }, intervalMs);
    intervalId.unref?.();
  }

  function finalize(timeoutMs = FINAL_UPLOAD_TIMEOUT_MS): Promise<void> {
    if (finalUpload) return finalUpload;
    clearUploadInterval();
    finalUpload = withTimeoutAndAbort(uploadNow(), {
      timeoutMs,
      timeoutMessage: 'Final control file log upload timed out',
      abortMessage: 'Final control file log upload aborted',
    })
      .catch(() => {
        reportFailure('timeout');
        logToFile('Final control file log upload timed out');
      })
      .finally(stop);
    return finalUpload;
  }

  function stop(): void {
    stopped = true;
    clearUploadInterval();
    activeUpload?.abort.abort();
    queuedUpload?.abort.abort();
  }

  return { start, uploadNow, finalize, stop };
}
