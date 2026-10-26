import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactLogText } from './log-redaction.js';

export type TarArchiveEntry = { directory: string; name: string };
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_ENTRIES = 1024;

/** Copy bounded, regular UTF-8 log files into a private, redacted archive tree. */
export function prepareLogArchive(paths: Array<string | TarArchiveEntry>):
  | {
      directory: string;
      cleanup: () => void;
    }
  | undefined {
  const directory = mkdtempSync(join(tmpdir(), 'kilo-safe-logs-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  let bytes = 0;
  let outputBytes = 0;
  let files = 0;
  let entries = 0;
  const copy = (source: string, name: string, depth: number): void => {
    if (++entries > MAX_ENTRIES || files >= MAX_FILES || bytes >= MAX_BYTES || depth > 4) return;
    if (isAbsolute(name) || name.split(/[\\/]/).includes('..') || name.length > 512) return;
    let fd: number | undefined;
    try {
      const st = lstatSync(source);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        const children = opendirSync(source);
        try {
          while (entries < MAX_ENTRIES && files < MAX_FILES && bytes < MAX_BYTES) {
            const child = children.readSync();
            if (child === null) break;
            copy(join(source, child.name), join(name, child.name), depth + 1);
          }
        } finally {
          children.closeSync();
        }
        return;
      }
      if (!st.isFile() || !/\.log(?:\.\d+)?$/.test(name) || st.size > MAX_BYTES - bytes) return;
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_BYTES - bytes) return;
      const buffer = Buffer.alloc(opened.size);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
      }
      const contents = buffer.subarray(0, length);
      bytes += length;
      if (contents.includes(0)) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
      const safeName = redactLogText(name);
      const destination = resolve(directory, safeName);
      if (!destination.startsWith(directory + sep)) return;
      const safe = redactLogText(text);
      const size = Buffer.byteLength(safe);
      if (outputBytes + size > MAX_BYTES) return;
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, safe, { mode: 0o600, flag: 'wx' });
      outputBytes += size;
      files += 1;
    } catch {
      // Missing, changed, non-text and unsafe files are excluded from diagnostics.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  try {
    for (const path of paths) {
      const entry =
        typeof path === 'string' ? { directory: dirname(path), name: basename(path) } : path;
      // Reject symlink traversal below the explicitly selected archive root.
      try {
        const root = realpathSync(entry.directory);
        const source = resolve(root, entry.name);
        if (relative(root, source).startsWith('..')) continue;
        let ancestor = source;
        let linked = false;
        while (ancestor !== root) {
          if (lstatSync(ancestor).isSymbolicLink()) {
            linked = true;
            break;
          }
          const parent = dirname(ancestor);
          if (parent === ancestor) {
            linked = true;
            break;
          }
          ancestor = parent;
        }
        if (!linked) copy(source, entry.name, 0);
      } catch {
        /* Missing sources produce no archive entry. */
      }
    }
    if (files) return { directory, cleanup };
  } catch {
    cleanup();
    return undefined;
  }
  cleanup();
  return undefined;
}
