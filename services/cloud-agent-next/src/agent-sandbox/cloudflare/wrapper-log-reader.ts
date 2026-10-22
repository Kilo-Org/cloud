import type { ExecOptions, ExecResult } from '@cloudflare/sandbox';

import { timedExec } from '../../sandbox-timeout-logging.js';
import type { WrapperLogSkipReason } from '../protocol.js';
import {
  readWrapperLogsWithinBudget,
  WRAPPER_LOG_LIMITS,
  type WrapperLogCandidate,
  type WrapperLogReadRequest,
  type WrapperLogReadout,
} from '../wrapper-log-budget.js';

/** The directory-entry fields a log readout consumes. */
export type WrapperLogEntry = {
  name: string;
  absolutePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  /** Size in bytes, as reported by the listing. */
  size: number;
  /** ISO modification time, as reported by the listing. */
  modifiedAt: string;
};

/** The slice of an execution session a log readout needs. */
export type WrapperLogSession = {
  listFiles(path: string): Promise<{ success: boolean; files: WrapperLogEntry[] }>;
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<{ content: string }>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
};

/**
 * One directory whose regular files are log candidates. `include` restricts the
 * readout to the files a directory is meant to hold; without it every regular
 * file counts.
 */
export type WrapperLogRoot = {
  path: string;
  include?: (name: string) => boolean;
  /** Descend into subdirectories. Defaults to true. */
  descend?: boolean;
};

export type WrapperLogDiscovery = {
  candidates: WrapperLogCandidate[];
  skipped: Record<string, WrapperLogSkipReason>;
};

export function isWrapperLogFileName(name: string): boolean {
  return name.startsWith('kilocode-wrapper-') && name.endsWith('.log');
}

/**
 * List each log root level by level, within the walk budget, and collect the
 * regular-file candidates together with the entries the readout drops. A
 * directory larger than the entry budget contributes its newest entries.
 */
export async function discoverWrapperLogCandidates(
  session: WrapperLogSession,
  roots: readonly WrapperLogRoot[]
): Promise<WrapperLogDiscovery> {
  const candidates: WrapperLogCandidate[] = [];
  const skipped: Record<string, WrapperLogSkipReason> = {};
  const pending = roots.map(root => ({ ...root, depth: 0 }));
  let listedDirectories = 0;

  while (pending.length > 0 && listedDirectories < WRAPPER_LOG_LIMITS.maxDirectories) {
    const directory = pending.shift();
    if (!directory) break;
    listedDirectories += 1;
    const listed = await session.listFiles(directory.path).catch(() => undefined);
    if (!listed?.success) continue;

    const ordered =
      listed.files.length > WRAPPER_LOG_LIMITS.maxDirectoryEntries
        ? [...listed.files].sort(
            (left, right) =>
              (Date.parse(right.modifiedAt) || 0) - (Date.parse(left.modifiedAt) || 0)
          )
        : listed.files;

    for (const entry of ordered.slice(0, WRAPPER_LOG_LIMITS.maxDirectoryEntries)) {
      const path = entry.absolutePath || `${directory.path}/${entry.name}`;
      if (entry.type === 'directory') {
        if (directory.descend !== false && directory.depth < WRAPPER_LOG_LIMITS.maxDepth) {
          pending.push({ ...directory, path, depth: directory.depth + 1 });
        }
        continue;
      }
      if (directory.include && !directory.include(entry.name)) continue;
      if (entry.type !== 'file') {
        skipped[path] = 'not-regular-file';
        continue;
      }
      candidates.push({
        path,
        size: entry.size,
        modifiedAtMs: Date.parse(entry.modifiedAt) || 0,
      });
    }
  }

  return { candidates, skipped };
}

/** Quote one path as a single shell word for the in-sandbox tail command. */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Return the requested bytes of one candidate, newest content last.
 *
 * A file that fits the cap is read whole. A larger file is read as its newest
 * bytes by `tail`, so the control plane never receives the full file.
 */
export async function readWrapperLogContent(
  session: WrapperLogSession,
  request: WrapperLogReadRequest
): Promise<string | undefined> {
  if (request.bytesToRead >= request.sizeBytes) {
    try {
      return (await session.readFile(request.path, { encoding: 'utf-8' })).content;
    } catch {
      return undefined;
    }
  }

  try {
    const tail = await timedExec(
      session,
      `tail -c ${request.bytesToRead} -- ${quoteShellArgument(request.path)}`,
      'wrapper-logs.tail',
      { timeoutMs: WRAPPER_LOG_LIMITS.tailTimeoutMs }
    );
    return tail.success ? tail.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** One bounded readout over the session's wrapper and CLI log roots. */
export async function readWrapperLogsForRoots(
  session: WrapperLogSession,
  roots: readonly WrapperLogRoot[]
): Promise<WrapperLogReadout> {
  const discovery = await discoverWrapperLogCandidates(session, roots);
  const readout = await readWrapperLogsWithinBudget({
    candidates: discovery.candidates,
    read: request => readWrapperLogContent(session, request),
  });
  return { ...readout, skipped: { ...discovery.skipped, ...readout.skipped } };
}
