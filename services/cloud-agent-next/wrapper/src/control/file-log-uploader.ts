import {
  CONTROL_LOG_ARCHIVE_NAME,
  controlUploadFailureStartsEpisode,
  type ControlDiagnosticProjector,
  type ControlDiagnosticReporter,
  type ControlLogUploadResult,
  type ControlUploadFailureSample,
} from '../../../src/shared/control-diagnostics.js';
import { logToFile, withTimeoutAndAbort } from '../utils.js';
import { createSecretRedactor } from '../redact-output.js';
import { collectControlFileLogArchive, defaultControlHomeRoots } from './file-log-archive.js';

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
  homeRoots?: readonly string[];
  environment?: Record<string, string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  onDiagnostic?: ControlDiagnosticReporter;
  projector?: ControlDiagnosticProjector;
  intervalMs?: number;
  uploadTimeoutMs?: number;
};

const DEFAULT_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';
const UPLOAD_TIMEOUT_MS = 15_000;
const FINAL_UPLOAD_TIMEOUT_MS = 5_000;
const INTERVAL_MS = 30_000;

export function createControlFileLogUploader(options: Options): ControlFileLogUploader {
  type Upload = { promise: Promise<void>; abort: AbortController };
  const upload = options.fetch ?? fetch;
  const wrapperLogPath = options.wrapperLogPath ?? DEFAULT_WRAPPER_LOG_PATH;
  const homeRoots = options.homeRoots ?? defaultControlHomeRoots();
  const redact = createSecretRedactor(
    options.environment ?? process.env,
    [{ CONTROL_LOG_UPLOAD_GRANT: options.uploadGrant }],
    ['CONTROL_LOG_UPLOAD_GRANT']
  );
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let activeUpload: Upload | undefined;
  let queuedUpload: Upload | undefined;
  let finalUpload: Promise<void> | undefined;
  let stopped = false;
  let lastFailureSample: ControlUploadFailureSample | undefined;

  function reportFailure(category: ControlLogUploadResult, statusCode?: number): void {
    try {
      const safeStatusCode =
        statusCode !== undefined && statusCode >= 100 && statusCode <= 599 ? statusCode : undefined;
      // The archive owner still buffers one R2 record per failure while the
      // uploader accepts; the native stderr line is a separate episode latch so
      // a repeated same-category failure does not repeat the line.
      options.onDiagnostic?.('control.upload', {
        phase: 'failed',
        category,
        statusCode: safeStatusCode,
      });
      const sample: ControlUploadFailureSample = {
        category,
        ...(safeStatusCode === undefined ? {} : { statusCode: safeStatusCode }),
      };
      if (
        options.projector?.enabled &&
        controlUploadFailureStartsEpisode(lastFailureSample, sample)
      ) {
        options.projector('control.upload', {
          phase: 'failed',
          category,
          statusCode: safeStatusCode,
        });
      }
      lastFailureSample = sample;
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

            const body = await collectControlFileLogArchive({
              wrapperLogPath,
              homeRoots,
              redact,
              signal: abort.signal,
            });
            abort.signal.throwIfAborted();
            if (!body) return;

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
            } else if (!abort.signal.aborted) {
              // A 204 accepts the archive: the next failure starts a new episode.
              lastFailureSample = undefined;
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
