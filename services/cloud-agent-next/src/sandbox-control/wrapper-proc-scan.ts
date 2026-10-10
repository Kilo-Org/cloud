import { CONTROL_WRAPPER_PATH } from './container-paths.js';

export const WRAPPER_PROC_SCAN_MAX_ENTRIES = 256;
export const WRAPPER_PROC_SCAN_MAX_ENTRY_BYTES = 8192;
export const WRAPPER_PROC_SCAN_MAX_OUTPUT_BYTES = 32;
export const WRAPPER_PROC_SCAN_MAX_COUNT = 99;

export type WrapperProcScanFs = {
  readdirSync(path: string): string[];
  openSync(path: string, flags: string): number;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number;
  closeSync(fd: number): void;
};

export type WrapperProcScanLimits = {
  wrapperPath: string;
  maxEntries: number;
  maxEntryBytes: number;
  maxCount: number;
};

export function wrapperProcScan(
  fs: WrapperProcScanFs,
  procRoot: string,
  limits: WrapperProcScanLimits
): string {
  let incomplete = false;
  let count = 0;
  const entries: string[] = [];
  try {
    const names = fs.readdirSync(procRoot);
    for (const name of names) {
      if (/^[0-9]+$/.test(name)) entries.push(name);
    }
  } catch {
    return 'n=0 incomplete';
  }
  if (entries.length > limits.maxEntries) {
    incomplete = true;
    entries.length = limits.maxEntries;
  }
  const decoder = new TextDecoder();
  for (const entry of entries) {
    let buffer: Uint8Array;
    let length = 0;
    try {
      buffer = new Uint8Array(limits.maxEntryBytes + 1);
      const fd = fs.openSync(procRoot + '/' + entry + '/cmdline', 'r');
      try {
        length = fs.readSync(fd, buffer, 0, limits.maxEntryBytes + 1, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      incomplete = true;
      continue;
    }
    if (length > limits.maxEntryBytes) {
      incomplete = true;
      continue;
    }
    if (length === 0) continue;
    const argv = decoder.decode(buffer.subarray(0, length)).split('\0');
    if (argv.length > 0 && argv[argv.length - 1] === '') argv.pop();
    if (
      argv.length === 3 &&
      argv[0] === 'bun' &&
      argv[1] === 'run' &&
      argv[2] === limits.wrapperPath
    ) {
      count++;
    }
  }
  return count > limits.maxCount ? 'unparsed' : 'n=' + count + (incomplete ? ' incomplete' : '');
}

export const WRAPPER_PROC_SCAN_LIMITS: WrapperProcScanLimits = {
  wrapperPath: CONTROL_WRAPPER_PATH,
  maxEntries: WRAPPER_PROC_SCAN_MAX_ENTRIES,
  maxEntryBytes: WRAPPER_PROC_SCAN_MAX_ENTRY_BYTES,
  maxCount: WRAPPER_PROC_SCAN_MAX_COUNT,
};

export const WRAPPER_PROC_SCAN_PROGRAM = `console.log((${wrapperProcScan.toString()})(require("fs"),"/proc",${JSON.stringify(
  WRAPPER_PROC_SCAN_LIMITS
)}));`;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export const WRAPPER_PROC_SCAN_COMMAND = `node -e ${shellSingleQuote(WRAPPER_PROC_SCAN_PROGRAM)}`;

export type WrapperProcScanResult =
  | { kind: 'count'; count: number; incomplete: boolean }
  | { kind: 'unparsed' };

const COUNT_RESULT = /^n=(\d{1,2})( incomplete)?$/;

export function parseWrapperProcScanOutput(stdout: string): WrapperProcScanResult {
  if (stdout.length === 0 || stdout.length > WRAPPER_PROC_SCAN_MAX_OUTPUT_BYTES) {
    return { kind: 'unparsed' };
  }
  const match = COUNT_RESULT.exec(stdout.trim());
  if (!match) return { kind: 'unparsed' };
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count > WRAPPER_PROC_SCAN_MAX_COUNT) {
    return { kind: 'unparsed' };
  }
  return { kind: 'count', count, incomplete: match[2] !== undefined };
}
