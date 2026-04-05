/**
 * Atomic file write: writes to a temp file then renames into place.
 * Ensures a crash mid-write cannot leave a corrupted target file.
 * Cleans up the temp file on failure.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type AtomicWriteDeps = {
  writeFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
};

const defaultDeps: AtomicWriteDeps = {
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  unlinkSync: p => fs.unlinkSync(p),
};

/**
 * Atomically write `data` to `filePath` by writing to a temp file first,
 * then renaming into place. The temp file is cleaned up on failure.
 */
export function atomicWrite(
  filePath: string,
  data: string,
  deps: AtomicWriteDeps = defaultDeps
): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.kilotmp.${crypto.randomBytes(6).toString('hex')}`);

  try {
    deps.writeFileSync(tmpPath, data);
    deps.renameSync(tmpPath, filePath);
  } catch (error) {
    // Clean up the temp file so we don't leak partial writes
    try {
      deps.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — the dotfile prefix keeps it hidden at least
    }
    throw error;
  }
}
