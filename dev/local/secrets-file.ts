import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Replaces `filePath` with `content` through a temp file in the destination's
 * directory. The temp file is created with mode 0o600 under an unpredictable
 * name, so the replacement never exposes the content to other local
 * principals. An existing destination whose mode grants nothing to group or
 * other keeps that stricter mode; a default-mode file ends at 0o600. Refuses
 * to write through a symlinked destination.
 *
 * Deliberately dependency-free: bootstrap scripts import this module before
 * any repo service configuration exists to load.
 */
export function writeSecretsFile(filePath: string, content: string): void {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${filePath} is a symlink; refusing to write through it`);
  }
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content);
      const existing = fs.statSync(filePath, { throwIfNoEntry: false });
      if (existing && (existing.mode & 0o077) === 0) {
        // Part of the same atomic rename as the content: the destination
        // never exists at any other mode than the one it keeps.
        fs.fchmodSync(fd, existing.mode & 0o777);
      }
      fs.renameSync(temp, filePath);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}
