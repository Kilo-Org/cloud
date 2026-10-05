/**
 * Validates the worker origin used to build wrapper-facing upload URLs. One
 * helper so the control-log and worktree-state grants agree on what a usable
 * origin is: an http(s) URL with no embedded credentials, query or fragment.
 * Returns the normalized (trailing-slash stripped) URL, or undefined.
 */
export function normalizeWorkerOrigin(workerUrl: string | undefined): string | undefined {
  const trimmed = workerUrl?.replace(/\/$/, '') ?? '';
  if (!trimmed) return undefined;
  try {
    const base = new URL(trimmed);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}
