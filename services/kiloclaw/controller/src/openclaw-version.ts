import { execFile } from 'node:child_process';

export type OpenclawVersionInfo = { version: string | null; commit: string | null };

const OPENCLAW_VERSION_RE = /(\d{4}\.\d{1,2}\.\d{1,2})(?:\s+\(([0-9a-f]+)\))?/;

export function parseOpenclawVersion(raw: string): OpenclawVersionInfo {
  const match = raw.match(OPENCLAW_VERSION_RE);
  if (!match) return { version: null, commit: null };
  return { version: match[1], commit: match[2] ?? null };
}

let openclawVersionPromise: Promise<OpenclawVersionInfo> | undefined;

/**
 * Resolve the installed openclaw version once and cache it for process lifetime.
 *
 * If openclaw is upgraded while the controller process is still running,
 * the cached value remains stale until the controller restarts.
 */
export function getOpenclawVersion(): Promise<OpenclawVersionInfo> {
  if (!openclawVersionPromise) {
    openclawVersionPromise = new Promise(resolve => {
      execFile(
        '/usr/bin/env',
        ['HOME=/root', 'openclaw', '--version'],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) {
            resolve({ version: null, commit: null });
            return;
          }
          resolve(parseOpenclawVersion(stdout.toString().trim()));
        }
      );
    });
  }
  return openclawVersionPromise;
}
