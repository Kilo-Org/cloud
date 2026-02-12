import { readFileSync } from 'node:fs';
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

function readFileIfExists(path: string): string | undefined {
  try {
    const content = readFileSync(path, 'utf-8');
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

async function uploadLogFile(
  baseUrl: string,
  userId: string,
  sessionId: string,
  executionId: string,
  token: string,
  filename: string,
  content: string
): Promise<void> {
  const url = `${baseUrl}/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}/logs/${encodeURIComponent(executionId)}/${filename}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: content,
  });
  if (!response.ok) {
    logToFile(`Log upload failed for ${filename}: ${response.status} ${response.statusText}`);
  }
}

export function createLogUploader(opts: LogUploaderOpts): LogUploader {
  let intervalId: ReturnType<typeof setInterval> | undefined;

  async function uploadNow(): Promise<void> {
    try {
      const uploads: Array<{ filename: string; path: string }> = [
        { filename: 'cli.txt', path: opts.cliLogPath },
        { filename: 'wrapper.log', path: opts.wrapperLogPath },
      ];
      for (const { filename, path } of uploads) {
        const content = readFileIfExists(path);
        if (content === undefined) {
          continue;
        }
        await uploadLogFile(
          opts.workerBaseUrl,
          opts.userId,
          opts.sessionId,
          opts.executionId,
          opts.kilocodeToken,
          filename,
          content
        );
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
