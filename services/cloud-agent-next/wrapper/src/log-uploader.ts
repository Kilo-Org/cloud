import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { logToFile, withTimeoutAndAbort } from './utils.js';

type LogUploadContext = {
  workerBaseUrl: string;
  kiloSessionId: string;
  workerAuthToken: string;
};

type LogUploaderOpts = {
  archiveId: string;
  context: LogUploadContext;
  sessionId: string;
  userId: string;
  /** Directory containing CLI log files (e.g. ~/.local/share/kilo/log/) */
  cliLogDir: string;
  wrapperLogPath: string;
};

export type LogUploader = {
  readonly archiveId: string;
  start: (intervalMs?: number) => void;
  updateContext: (context: LogUploadContext) => void;
  uploadNow: () => Promise<void>;
  finalize: (timeoutMs?: number) => Promise<void>;
  stop: () => void;
};

const UPLOAD_TIMEOUT_MS = 15_000;
const FINAL_UPLOAD_TIMEOUT_MS = 5_000;

export function createLogArchiveId(wrapperRunId: string): string {
  return `${wrapperRunId}--${randomUUID()}`;
}

type TarStream = {
  stream: ReadableStream<Uint8Array>;
  kill: () => void;
};

function createTarStream(paths: Array<string>): TarStream | undefined {
  const existing = paths.filter(f => existsSync(f));
  if (existing.length === 0) return undefined;

  // Use -C parent basename for each path so the archive contains relative names, not full paths.
  // Works for both files and directories.
  const tarArgs = ['czf', '-'];
  for (const f of existing) {
    tarArgs.push('-C', dirname(f), basename(f));
  }
  const proc = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const { stdout, stderr: stderrStream } = proc;
  if (!stdout || !stderrStream) return undefined;

  stderrStream.resume();
  proc.on('close', code => {
    if (code !== 0) logToFile(`tar exited with code ${code}`);
  });

  const stream = new ReadableStream({
    start(controller) {
      let done = false;
      const close = () => {
        if (!done) {
          done = true;
          controller.close();
        }
      };
      const error = (err: Error) => {
        if (!done) {
          done = true;
          controller.error(err);
        }
      };
      stdout.on('data', (chunk: Buffer) => {
        if (!done) controller.enqueue(new Uint8Array(chunk));
      });
      stdout.on('end', close);
      stdout.on('error', error);
      proc.on('error', err => {
        logToFile('tar spawn error');
        error(err);
      });
    },
  });

  return { stream: stream as ReadableStream<Uint8Array>, kill: () => proc.kill() };
}

export function createLogUploader(opts: LogUploaderOpts): LogUploader {
  type Upload = { promise: Promise<void>; abort: AbortController };

  const { archiveId, sessionId, userId, cliLogDir, wrapperLogPath } = opts;
  let context = { ...opts.context };
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let activeUpload: Upload | undefined;
  let queuedUpload: Upload | undefined;
  let finalUpload: Promise<void> | undefined;
  let stopped = false;

  function uploadNow(): Promise<void> {
    if (finalUpload) return finalUpload;
    if (stopped) return Promise.resolve();
    if (queuedUpload) return queuedUpload.promise;

    const uploadContext = { ...context };
    const previousUpload = activeUpload;
    const abort = new AbortController();
    const upload: Upload = { promise: performUpload(), abort };
    if (previousUpload) queuedUpload = upload;
    else activeUpload = upload;
    return upload.promise;

    async function performUpload(): Promise<void> {
      let tar: TarStream | undefined;
      try {
        await withTimeoutAndAbort(
          (async () => {
            await previousUpload?.promise;
            abort.signal.throwIfAborted();
            if (queuedUpload === upload) queuedUpload = undefined;
            activeUpload = upload;

            const url = new URL(
              `${uploadContext.workerBaseUrl}/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}/logs/${encodeURIComponent(archiveId)}/logs.tar.gz`
            );
            url.searchParams.set('kiloSessionId', uploadContext.kiloSessionId);
            tar = createTarStream([cliLogDir, wrapperLogPath]);
            if (!tar) return;

            const response = await fetch(url, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${uploadContext.workerAuthToken}` },
              body: tar.stream,
              // @ts-expect-error -- Node/Bun fetch supports duplex for streaming request bodies
              duplex: 'half',
              signal: abort.signal,
            });
            if (!abort.signal.aborted && !response.ok) {
              logToFile(`Log upload failed: ${response.status}`);
            }
          })(),
          {
            timeoutMs: UPLOAD_TIMEOUT_MS,
            timeoutMessage: 'Log upload timed out',
            signal: abort.signal,
            abortMessage: 'Log upload aborted',
          }
        );
      } catch {
        logToFile('Log upload did not complete');
      } finally {
        abort.abort();
        tar?.kill();
        if (activeUpload === upload) activeUpload = undefined;
        if (queuedUpload === upload) queuedUpload = undefined;
      }
    }
  }

  function clearUploadInterval(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }

  function start(intervalMs = 30_000): void {
    stop();
    stopped = false;
    finalUpload = undefined;
    intervalId = setInterval(() => {
      if (!activeUpload && !queuedUpload) void uploadNow();
    }, intervalMs);
  }

  function finalize(timeoutMs = FINAL_UPLOAD_TIMEOUT_MS): Promise<void> {
    if (finalUpload) return finalUpload;
    clearUploadInterval();
    finalUpload = withTimeoutAndAbort(uploadNow(), {
      timeoutMs,
      timeoutMessage: 'Final log upload timed out',
      abortMessage: 'Final log upload aborted',
    })
      .catch(() => logToFile('Final log upload timed out'))
      .finally(stop);
    return finalUpload;
  }

  function stop(): void {
    stopped = true;
    clearUploadInterval();
    activeUpload?.abort.abort();
    queuedUpload?.abort.abort();
  }

  return {
    archiveId,
    start,
    updateContext: nextContext => {
      context = { ...nextContext };
    },
    uploadNow,
    finalize,
    stop,
  };
}
