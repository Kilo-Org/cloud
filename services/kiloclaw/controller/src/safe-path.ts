import path from 'node:path';

export class SafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafePathError';
  }
}

/**
 * Resolve a relative path within a root directory, rejecting any escape attempts.
 * Returns the absolute resolved path (not canonicalized — callers should use
 * `verifyCanonicalized` after confirming the path exists on disk).
 */
export function resolveSafePath(relativePath: string, rootDir: string): string {
  if (!relativePath) {
    throw new SafePathError('Path must not be empty');
  }

  if (relativePath.includes('\0')) {
    throw new SafePathError('Path must not contain null bytes');
  }

  if (path.isAbsolute(relativePath)) {
    throw new SafePathError('Path must be relative');
  }

  const resolved = path.resolve(rootDir, relativePath);

  if (resolved !== rootDir && !resolved.startsWith(rootDir + '/')) {
    throw new SafePathError('Path escapes root directory');
  }

  return resolved;
}

/**
 * Verify that a resolved path, after canonicalization via realpath, still
 * stays within the root directory. This catches symlinked ancestors that
 * escape the allowed tree.
 */
export function verifyCanonicalized(canonicalPath: string, rootDir: string): void {
  if (canonicalPath !== rootDir && !canonicalPath.startsWith(rootDir + '/')) {
    throw new SafePathError('Path escapes root directory via symlink');
  }
}
