import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack as tarPack } from 'tar-stream';
import {
  configure as configureZip,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from '@zip.js/zip.js';

// zip.js spins up Web Workers by default for codec parallelism. The controller
// runs as a single-file Node bundle with no worker entrypoint, so disable them
// and run codecs inline.
configureZip({ useWebWorkers: false });

/** Workspace directory (relative to the controller rootDir, i.e. ~/.openclaw). */
export const OPENCLAW_EXPORT_WORKSPACE_DIR = 'workspace';

export const OPENCLAW_EXPORT_FORMATS = ['tar.gz', 'zip'] as const;
export type OpenclawExportFormat = (typeof OPENCLAW_EXPORT_FORMATS)[number];

export const OPENCLAW_EXPORT_MAX_FILES = 2000;
export const OPENCLAW_EXPORT_MAX_FILE_BYTES = 10 * 1024 * 1024; // per file
export const OPENCLAW_EXPORT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // total uncompressed
// The produced archive must cross the Cloudflare Durable Object RPC boundary,
// which caps serialized return values at 32 MiB. Keep headroom under that.
export const OPENCLAW_EXPORT_MAX_ARCHIVE_BYTES = 28 * 1024 * 1024;

/** Directory names that are never exported (VCS metadata, deps, generated). */
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules']);
/** Exact file names that are never exported (OS junk). */
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
/** File-name suffixes that are never exported (transient/runtime). */
const EXCLUDED_FILE_SUFFIXES = ['.tmp', '.swp', '.sock', '.pid', '.lock'];

export class OpenclawExportError extends Error {
  readonly code: string;
  readonly status: 400 | 413;
  constructor(message: string, code: string, status: 400 | 413 = 400) {
    super(message);
    this.name = 'OpenclawExportError';
    this.code = code;
    this.status = status;
  }
}

export type OpenclawExportEntry = {
  /** Archive path, relative to the workspace root (e.g. `USER.md`, `memory/x.md`). */
  path: string;
  content: Uint8Array;
};

export type OpenclawExportCollection = {
  entries: OpenclawExportEntry[];
  totalBytes: number;
  /** Count of paths skipped by the exclusion rules (dirs/files/non-regular). */
  skippedCount: number;
};

function isExcludedFileName(name: string): boolean {
  if (EXCLUDED_FILE_NAMES.has(name)) return true;
  return EXCLUDED_FILE_SUFFIXES.some(suffix => name.toLowerCase().endsWith(suffix));
}

/**
 * Recursively collect regular files under the workspace directory, reading their
 * bytes into memory. Skips symlinks, excluded dirs/files, and non-regular files.
 * Enforces per-file, total-size, and file-count caps. Archive paths are relative
 * to the workspace root (no leading `workspace/`).
 *
 * @param workspaceDir absolute path to ~/.openclaw/workspace
 */
export function collectOpenclawWorkspaceFiles(workspaceDir: string): OpenclawExportCollection {
  const entries: OpenclawExportEntry[] = [];
  let totalBytes = 0;
  let skippedCount = 0;

  if (!fs.existsSync(workspaceDir)) {
    return { entries, totalBytes, skippedCount };
  }

  // Refuse to follow a symlinked workspace root.
  const rootStat = fs.lstatSync(workspaceDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { entries, totalBytes, skippedCount };
  }

  const pendingDirs: string[] = [workspaceDir];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue; // skip unreadable directories
    }

    for (const dirent of dirents) {
      // Never follow symlinks (defends against escaping the workspace root).
      if (dirent.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }

      const absolutePath = path.join(currentDir, dirent.name);

      if (dirent.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(dirent.name)) {
          skippedCount += 1;
          continue;
        }
        pendingDirs.push(absolutePath);
        continue;
      }

      if (!dirent.isFile()) {
        // sockets / fifos / block / char devices
        skippedCount += 1;
        continue;
      }

      if (isExcludedFileName(dirent.name)) {
        skippedCount += 1;
        continue;
      }

      const archivePath = path.relative(workspaceDir, absolutePath).split(path.sep).join('/');

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        skippedCount += 1;
        continue;
      }

      if (stat.size > OPENCLAW_EXPORT_MAX_FILE_BYTES) {
        throw new OpenclawExportError(
          `File exceeds the ${OPENCLAW_EXPORT_MAX_FILE_BYTES}-byte per-file limit: ${archivePath}`,
          'openclaw_export_too_large',
          413
        );
      }

      totalBytes += stat.size;
      if (totalBytes > OPENCLAW_EXPORT_MAX_TOTAL_BYTES) {
        throw new OpenclawExportError(
          `Workspace exceeds the ${OPENCLAW_EXPORT_MAX_TOTAL_BYTES}-byte export limit`,
          'openclaw_export_too_large',
          413
        );
      }

      if (entries.length >= OPENCLAW_EXPORT_MAX_FILES) {
        throw new OpenclawExportError(
          `Workspace exceeds the ${OPENCLAW_EXPORT_MAX_FILES}-file export limit`,
          'openclaw_export_too_many_files'
        );
      }

      let content: Buffer;
      try {
        content = fs.readFileSync(absolutePath);
      } catch {
        skippedCount += 1;
        totalBytes -= stat.size;
        continue;
      }

      entries.push({ path: archivePath, content });
    }
  }

  // Stable, deterministic ordering for reproducible archives.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { entries, totalBytes, skippedCount };
}

/** Build a gzipped tar (.tar.gz) from the collected entries. */
export function buildOpenclawWorkspaceTarGz(entries: OpenclawExportEntry[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('error', reject);
    pack.on('end', () => {
      try {
        resolve(gzipSync(Buffer.concat(chunks)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    (async () => {
      for (const entry of entries) {
        await new Promise<void>((entryResolve, entryReject) => {
          pack.entry({ name: entry.path }, Buffer.from(entry.content), err =>
            err ? entryReject(err) : entryResolve()
          );
        });
      }
      pack.finalize();
    })().catch(reject);
  });
}

/**
 * Build a .zip from the collected entries. When `password` is supplied the zip is
 * AES-256 encrypted (WinZip AES, encryptionStrength 3).
 */
export async function buildOpenclawWorkspaceZip(
  entries: OpenclawExportEntry[],
  password?: string
): Promise<Uint8Array> {
  const zipWriter = new ZipWriter(
    new Uint8ArrayWriter(),
    password ? { password, encryptionStrength: 3 } : {}
  );
  for (const entry of entries) {
    await zipWriter.add(entry.path, new Uint8ArrayReader(entry.content));
  }
  return zipWriter.close();
}

export function openclawExportContentType(format: OpenclawExportFormat): string {
  return format === 'zip' ? 'application/zip' : 'application/gzip';
}

export function openclawExportFileName(format: OpenclawExportFormat): string {
  return `openclaw-workspace-export.${format}`;
}
