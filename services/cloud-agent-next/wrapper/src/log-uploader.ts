import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { logToFile } from './utils.js';

type LogUploaderOpts = {
  workerBaseUrl: string;
  sessionId: string;
  executionId: string;
  userId: string;
  workerAuthToken: string;
  /** Directory containing CLI log files (e.g. ~/.local/share/kilo/log/) */
  cliLogDir: string;
  wrapperLogPath: string;
};

export type LogUploader = {
  start: (intervalMs?: number) => void;
  uploadNow: () => Promise<void>;
  stop: () => void;
};

const UPLOAD_TIMEOUT_MS = 15_000;

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

  let stderr = '';
  stderrStream.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on('close', code => {
    if (code !== 0) logToFile(`tar exited with code ${code}: ${stderr}`);
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
        logToFile(`tar spawn error: ${err.message}`);
        error(err);
      });
    },
  });

  return { stream: stream as ReadableStream<Uint8Array>, kill: () => proc.kill() };
}

export function createLogUploader(opts: LogUploaderOpts): LogUploader {
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let isUploading = false;

  async function uploadNow(): Promise<void> {
    if (isUploading) return;
    isUploading = true;
    const tar = createTarStream([opts.cliLogDir, opts.wrapperLogPath]);
    if (!tar) {
      isUploading = false;
      return;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const url = `${opts.workerBaseUrl}/sessions/${encodeURIComponent(opts.userId)}/${encodeURIComponent(opts.sessionId)}/logs/${encodeURIComponent(opts.executionId)}/logs.tar.gz`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${opts.workerAuthToken}` },
        body: tar.stream,
        // @ts-expect-error -- Node/Bun fetch supports duplex for streaming request bodies
        duplex: 'half',
        signal: abort.signal,
      });
      if (!response.ok) {
        logToFile(`Log upload failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (abort.signal.aborted) {
        logToFile(`Log upload timed out after ${UPLOAD_TIMEOUT_MS}ms`);
      } else {
        logToFile(`Log upload error: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearTimeout(timer);
      tar.kill();
      isUploading = false;
    }
  }

  function start(intervalMs = 30_000): void {
    stop();
    intervalId = setInterval(() => {
      uploadNow().catch(() => {});
    }, intervalMs);
  }

  function stop(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }

  return { start, uploadNow, stop };
}
