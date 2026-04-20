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
  /**
   * Only required when callers pass `options.mode`. Omitting this from the
   * deps is fine for plain writes — atomicWrite throws a clear error if a
   * mode is requested without a chmodSync to apply it.
   */
  chmodSync?: (path: string, mode: number) => void;
};

const defaultDeps: AtomicWriteDeps = {
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  unlinkSync: p => fs.unlinkSync(p),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
};

export type AtomicWriteOptions = {
  /**
   * POSIX file mode to apply before the atomic rename. When set, chmod runs
   * on the TEMP file (not the final path) and the rename then commits the
   * already-moded file into place. This ordering is deliberate: if the
   * chmod fails, the rename never happens and the existing target file is
   * untouched; if the chmod succeeded but the rename fails, the catch
   * block unlinks the still-present temp file. Either way, the final path
   * only ever holds the intended mode or its previous state, never the
   * default-umask "in-between" state.
   *
   * Use this for files that contain secrets (e.g. openclaw.json contains
   * API keys and gateway tokens) where default umask (typically 0o644)
   * would leave the file world-readable. Omit for plain user data where
   * umask default is fine.
   */
  mode?: number;
};

/**
 * Atomically write `data` to `filePath` by writing to a temp file first,
 * then renaming into place. The temp file is cleaned up on failure.
 */
export function atomicWrite(
  filePath: string,
  data: string,
  deps: AtomicWriteDeps = defaultDeps,
  options: AtomicWriteOptions = {}
): void {
  // Narrow chmodSync once up front so the inner check at the write site
  // flows the definedness through without an ! assertion. Either mode is
  // unset (chmodSync is never called) or mode is set and we require a
  // chmodSync in deps — the two-branch guard below enforces this.
  const { chmodSync } = deps;
  if (options.mode !== undefined && chmodSync === undefined) {
    throw new Error('atomicWrite: options.mode was specified but deps.chmodSync is not provided');
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.kilotmp.${crypto.randomBytes(6).toString('hex')}`);

  try {
    deps.writeFileSync(tmpPath, data);
    // Chmod BEFORE rename so the mode change is part of the commit. If the
    // chmod throws, the still-present temp file is unlinked in the catch
    // below and the target file at `filePath` is untouched — rather than
    // being committed at the default-umask mode the write-only path would
    // leave it in.
    if (options.mode !== undefined && chmodSync !== undefined) {
      chmodSync(tmpPath, options.mode);
    }
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
