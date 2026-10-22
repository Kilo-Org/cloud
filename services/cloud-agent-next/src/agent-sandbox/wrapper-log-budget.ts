import type { WrapperLogSkipReason, WrapperLogTruncation } from './protocol.js';

/**
 * Fixed budget for one wrapper-log readout.
 *
 * The readout serves debugging, so it returns the newest content and names what
 * it left out. Every number is a hard bound on what the control plane holds for
 * one request, independent of what the sandbox filesystem contains.
 */
export const WRAPPER_LOG_LIMITS = {
  /** Files whose content the readout returns. */
  maxFiles: 16,
  /** Bytes returned from any single file; larger files are returned as a tail. */
  maxFileBytes: 256 * 1024,
  /** Bytes returned across every file of one readout. */
  maxTotalBytes: 512 * 1024,
  /** Candidates kept for selection before the file and byte allowances apply. */
  maxCandidates: 64,
  /** Directory levels walked below each log root. */
  maxDepth: 2,
  /** Directories listed for one readout, across every root. */
  maxDirectories: 8,
  /** Entries examined per listed directory. */
  maxDirectoryEntries: 64,
  /** Timeout for reading the tail of one oversized file. */
  tailTimeoutMs: 15_000,
} as const;

export type WrapperLogCandidate = {
  path: string;
  /** Size reported by the directory listing, in bytes. */
  size: number;
  /** Modification time reported by the directory listing, in milliseconds. */
  modifiedAtMs: number;
};

export type WrapperLogReadRequest = {
  path: string;
  /** Bytes to return, counted from the end of the file. */
  bytesToRead: number;
  /** Size reported by the directory listing. */
  sizeBytes: number;
};

/** Returns the requested bytes of one candidate, or `undefined` when unreadable. */
export type WrapperLogReader = (request: WrapperLogReadRequest) => Promise<string | undefined>;

export type WrapperLogReadout = {
  files: Record<string, string>;
  truncated: Record<string, WrapperLogTruncation>;
  skipped: Record<string, WrapperLogSkipReason>;
  omittedFileCount: number;
};

/**
 * Read log candidates newest first within {@link WRAPPER_LOG_LIMITS}.
 *
 * Cancelled reads do not consume the byte allowance, so an unreadable file never
 * hides a readable one. A candidate over the per-file cap is requested as its
 * newest bytes; `truncated` records the byte split.
 */
export async function readWrapperLogsWithinBudget(input: {
  candidates: readonly WrapperLogCandidate[];
  read: WrapperLogReader;
  limits?: typeof WRAPPER_LOG_LIMITS;
}): Promise<WrapperLogReadout> {
  const limits = input.limits ?? WRAPPER_LOG_LIMITS;
  const ordered = [...input.candidates].sort(
    (left, right) => right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path)
  );
  const considered = ordered.slice(0, limits.maxCandidates);

  const files: Record<string, string> = {};
  const truncated: Record<string, WrapperLogTruncation> = {};
  const skipped: Record<string, WrapperLogSkipReason> = {};
  let remainingBytes = limits.maxTotalBytes;
  let readCount = 0;

  for (const candidate of considered) {
    if (readCount >= limits.maxFiles) {
      skipped[candidate.path] = 'file-limit';
      continue;
    }
    if (candidate.size > 0 && remainingBytes === 0) {
      skipped[candidate.path] = 'byte-limit';
      continue;
    }

    const bytesToRead = Math.min(candidate.size, limits.maxFileBytes, remainingBytes);
    const content = await input.read({
      path: candidate.path,
      bytesToRead,
      sizeBytes: candidate.size,
    });
    if (content === undefined) {
      skipped[candidate.path] = 'read-failed';
      continue;
    }

    files[candidate.path] = content;
    remainingBytes -= bytesToRead;
    readCount += 1;
    if (bytesToRead < candidate.size) {
      truncated[candidate.path] = {
        returnedBytes: bytesToRead,
        omittedBytes: candidate.size - bytesToRead,
      };
    }
  }

  return {
    files,
    truncated,
    skipped,
    omittedFileCount: ordered.length - considered.length,
  };
}
