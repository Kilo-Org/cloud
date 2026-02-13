import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { logToFile } from './utils.js';

type LogUploaderOpts = {
  workerBaseUrl: string;
  sessionId: string;
  executionId: string;
  userId: string;
  kilocodeToken: string;
  cliLogPath: string;
  wrapperLogPath: string;
};

type LogUploader = {
  start: (intervalMs?: number) => void;
  uploadNow: () => Promise<void>;
  stop: () => void;
};

function createTarStream(files: Array<string>): ReadableStream<Uint8Array> | undefined {
  const existing = files.filter(f => existsSync(f));
  if (existing.length === 0) return undefined;

  // Use -C dir basename for each file so the archive contains only filenames, not full paths
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

  return new ReadableStream({
    start(controller) {
      stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stdout.on('end', () => controller.close());
      stdout.on('error', err => controller.error(err));
    },
  });
}

export function createLogUploader(opts: LogUploaderOpts): LogUploader {
  let intervalId: ReturnType<typeof setInterval> | undefined;

  async function uploadNow(): Promise<void> {
    try {
      const stream = createTarStream([opts.cliLogPath, opts.wrapperLogPath]);
      if (!stream) return;

      const url = `${opts.workerBaseUrl}/sessions/${encodeURIComponent(opts.userId)}/${encodeURIComponent(opts.sessionId)}/logs/${encodeURIComponent(opts.executionId)}/logs.tar.gz`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${opts.kilocodeToken}` },
        body: stream,
        // @ts-expect-error -- Node/Bun fetch supports duplex for streaming request bodies
        duplex: 'half',
      });
      if (!response.ok) {
        logToFile(`Log upload failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      logToFile(`Log upload error: ${error instanceof Error ? error.message : String(error)}`);
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
