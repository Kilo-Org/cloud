/**
 * The single owner of the runtime archive scanner: a plain-JS source string with
 * no imports, no TypeScript, and no evaluation. The embedded installer renders this
 * exact trusted text; the Node/Bun packaging script compiles it under tooling only.
 * This module is safe to import from Worker code (it holds only a string).
 */

/** A regular file entry from a validated archive. */
export type RuntimeArchiveFile = { path: string; mode: number; bytes: Uint8Array };
export type RuntimeArchiveScan = {
  files: RuntimeArchiveFile[];
  fileCount: number;
  expandedBytes: number;
};

/**
 * Plain-JS scanner source defining `class RuntimeArchiveError` and
 * `function scanRuntimeArchive(tar)`. It uses only globals so the same text runs
 * when embedded and when compiled by tooling.
 */
export const RUNTIME_ARCHIVE_SCANNER_SOURCE = String.raw`class RuntimeArchiveError extends Error {
  constructor(message) { super(message); this.name = 'RuntimeArchiveError'; }
}
function scanRuntimeArchive(tar) {
  function fail(message) { throw new RuntimeArchiveError(message); }
  function decode(bytes) {
    let end = bytes.length;
    for (let i = 0; i < bytes.length; i += 1) { if (bytes[i] === 0) { end = i; break; } }
    return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
  }
  function numeric(field) {
    if ((field[0] & 0x80) !== 0) {
      const negative = (field[0] & 0x40) !== 0;
      let value = field[0] & 0x3f;
      for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
      return negative ? -value : value;
    }
    const text = decode(field).trim();
    if (text === '') return 0;
    if (!/^[0-7]+$/.test(text)) fail('invalid numeric tar field');
    return parseInt(text, 8);
  }
  function checksum(header) {
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    return sum;
  }
  function paxPath(data) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let index = 0;
    let found = null;
    while (index < data.byteLength) {
      const space = data.indexOf(32, index);
      if (space === -1) fail('invalid PAX record length');
      const digits = decoder.decode(data.subarray(index, space));
      if (!/^[1-9][0-9]*$/.test(digits)) fail('invalid PAX record length');
      const length = Number(digits);
      const end = index + length;
      if (!Number.isSafeInteger(length) || end > data.byteLength || end <= space + 1 || data[end - 1] !== 10)
        fail('invalid PAX record span');
      const record = decoder.decode(data.subarray(space + 1, end - 1));
      const equals = record.indexOf('=');
      if (equals === -1) fail('invalid PAX record');
      if (record.slice(0, equals) === 'path') found = record.slice(equals + 1);
      index = end;
    }
    return found;
  }
  const files = [];
  const seen = new Set();
  let offset = 0;
  let pax = null;
  let longName = null;
  let fileCount = 0;
  let expandedBytes = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    let allZero = true;
    for (let z = 0; z < 512; z += 1) { if (header[z] !== 0) { allZero = false; break; } }
    if (allZero) break;
    if (checksum(header) !== numeric(header.subarray(148, 156))) fail('tar header checksum mismatch');
    const type = header[156];
    const size = numeric(header.subarray(124, 136));
    if (size < 0) fail('negative tar entry size');
    offset += 512;
    if (offset + size > tar.length) fail('truncated tar entry');
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 120 || type === 88) { pax = paxPath(data); continue; }
    if (type === 103) continue;
    if (type === 76) { longName = decode(data); continue; }
    const isFile = type === 0 || type === 48;
    const isDir = type === 53;
    if (!isFile && !isDir) fail('unsupported tar entry type ' + type);
    const shortName = decode(header.subarray(0, 100));
    const prefix = decode(header.subarray(345, 500));
    const raw = pax || longName || (prefix === '' ? shortName : prefix + '/' + shortName);
    pax = null;
    longName = null;
    const normalized = raw.replace(/\/+$/, '');
    if (normalized === '' || normalized.charAt(0) === '/') fail('unsafe archive path: ' + raw);
    const parts = normalized.split('/');
    for (let part = 0; part < parts.length; part += 1) { if (parts[part] === '' || parts[part] === '.' || parts[part] === '..') fail('unsafe archive path: ' + raw); }
    if (seen.has(normalized)) fail('duplicate archive path: ' + raw);
    seen.add(normalized);
    if (isDir) continue;
    fileCount += 1;
    expandedBytes += size;
    files.push({ path: normalized, mode: numeric(header.subarray(100, 108)), bytes: data });
  }
  return { files: files, fileCount: fileCount, expandedBytes: expandedBytes };
}`;
