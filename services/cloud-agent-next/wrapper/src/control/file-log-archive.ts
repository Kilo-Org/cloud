import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTROL_LOG_MAX_ARCHIVE_BYTES } from '../../../src/shared/control-diagnostics.js';
import { defaultHomeRoots } from '../control-plane/workspace-home.js';
import { createTarStream, type TarArchiveEntry } from '../log-uploader.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 64;
const TRUNCATED = '\n[TRUNCATED: retained complete log lines within the capture limit]\n';
const OMITTED = '[TRUNCATED: additional log files omitted by the total capture limit]\n';

export function defaultControlHomeRoots(): string[] {
  const roots = defaultHomeRoots();
  return [roots.legacy, roots.directory];
}

type LogFile = { path: string; name: string; mtime: number };

async function logFiles(wrapperLogPath: string, homeRoots: readonly string[]): Promise<LogFile[]> {
  const native: LogFile[] = [];
  for (const root of homeRoots) {
    const homes = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const home of homes) {
      if (!home.isDirectory()) continue;
      for (const runtime of ['kilo', 'kilo2']) {
        let directory = path.join(root, home.name);
        let valid = true;
        for (const part of ['.local', 'share', runtime, 'log']) {
          directory = path.join(directory, part);
          const stat = await lstat(directory).catch(() => undefined);
          if (!stat?.isDirectory()) {
            valid = false;
            break;
          }
        }
        if (!valid) continue;
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = path.join(directory, entry.name);
          const stat = await lstat(filePath).catch(() => undefined);
          if (!stat?.isFile()) continue;
          native.push({ path: filePath, name: path.relative(root, filePath), mtime: stat.mtimeMs });
        }
      }
    }
  }
  native.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  return [{ path: wrapperLogPath, name: path.basename(wrapperLogPath), mtime: 0 }, ...native];
}

async function captureFile(
  filePath: string,
  maxBytes: number,
  redact: (text: string) => string
): Promise<Buffer | undefined> {
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch(() => undefined);
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return undefined;
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    let truncated = start > 0 || bytesRead < buffer.length;
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    if (truncated || (await file.stat()).size > stat.size) {
      text = text.slice(0, text.lastIndexOf('\n') + 1);
      truncated = true;
    }
    const safe = Buffer.from(redact(text));
    if (!truncated && safe.length <= maxBytes) return safe;
    const trimStart = Math.max(0, safe.length - maxBytes + Buffer.byteLength(TRUNCATED));
    if (trimStart === 0) return Buffer.concat([Buffer.from(TRUNCATED), safe]);
    const retained = safe.subarray(trimStart);
    const lineStart = retained.indexOf('\n');
    return Buffer.concat([
      Buffer.from(TRUNCATED),
      lineStart < 0 ? Buffer.alloc(0) : retained.subarray(lineStart + 1),
    ]);
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

export async function collectControlFileLogArchive(input: {
  wrapperLogPath: string;
  homeRoots: readonly string[];
  redact: (text: string) => string;
  signal: AbortSignal;
}): Promise<Uint8Array | undefined> {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'kilo-control-logs-'));
  try {
    const files = await logFiles(input.wrapperLogPath, input.homeRoots);
    const entries: TarArchiveEntry[] = [];
    let remaining = MAX_CONTENT_BYTES - Buffer.byteLength(OMITTED);
    for (const [index, file] of files.entries()) {
      input.signal.throwIfAborted();
      if (index >= MAX_FILES || remaining < Buffer.byteLength(TRUNCATED)) {
        await writeFile(path.join(staging, 'TRUNCATED.txt'), OMITTED, { mode: 0o600 });
        entries.push({ directory: staging, name: 'TRUNCATED.txt' });
        break;
      }
      const body = await captureFile(file.path, Math.min(MAX_FILE_BYTES, remaining), input.redact);
      if (!body) continue;
      input.signal.throwIfAborted();
      await mkdir(path.dirname(path.join(staging, file.name)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, file.name), body, { mode: 0o600 });
      remaining -= body.byteLength;
      entries.push({ directory: staging, name: file.name });
    }
    input.signal.throwIfAborted();
    const tar = createTarStream(entries);
    if (!tar) return undefined;
    const abort = () => tar.kill();
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      const reader = tar.stream.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        input.signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length > CONTROL_LOG_MAX_ARCHIVE_BYTES)
          throw new Error('Control log archive exceeded cap');
        chunks.push(value);
      }
      return Buffer.concat(chunks, length);
    } finally {
      input.signal.removeEventListener('abort', abort);
      tar.kill();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
