/**
 * Formats OS-level file system errors with descriptive context.
 *
 * When a file read/write fails due to an OS error (ENOENT, EACCES, EISDIR, etc.),
 * this helper produces a message that:
 * 1. Identifies the error as an OS-level filesystem issue (not a gateway/application bug)
 * 2. Includes the file path that failed
 * 3. Preserves the original OS error code and message
 */

const OS_ERROR_CODES: Record<string, string> = {
  ENOENT: 'file or directory not found',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EISDIR: 'path is a directory, not a file',
  ENOTDIR: 'a component of the path is not a directory',
  EMFILE: 'too many open files',
  ENFILE: 'system file table overflow',
  ENOSPC: 'no space left on device',
  EROFS: 'read-only file system',
  EBUSY: 'file is busy or locked',
  ENOTEMPTY: 'directory not empty',
  EEXIST: 'file already exists',
};

function describeErrnoCode(code: string): string {
  return OS_ERROR_CODES[code] ?? `OS error ${code}`;
}

/**
 * Format an OS-level file error into a descriptive message.
 *
 * @param err - The caught error
 * @param filePath - The file path involved in the operation
 * @param operation - What was being attempted (e.g. "read", "write", "delete")
 * @returns A human-readable error message attributing the failure to the OS/filesystem
 */
export function formatFileError(err: unknown, filePath: string, operation = 'read'): string {
  const errno = err as NodeJS.ErrnoException;
  if (errno.code) {
    const description = describeErrnoCode(errno.code);
    return `OS file ${operation} error for "${filePath}": ${description} (${errno.code}). This is a host filesystem issue, not a gateway error.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `OS file ${operation} error for "${filePath}": ${message}. This is a host filesystem issue, not a gateway error.`;
}

/**
 * Check whether an error is an OS-level ENOENT (file not found).
 */
export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}
