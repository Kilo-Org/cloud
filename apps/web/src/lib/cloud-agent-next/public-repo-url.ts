/**
 * Local-development escape hatch for Cloud Agent sessions: run against an
 * arbitrary public repository URL when no source-control integration is
 * configured. The control plane already supports this as a plain `git` clone
 * (the E2E harness's `E2E_GIT_URL` path), so this only adds a UI affordance and
 * a `prepareSession` input; both are gated to development here.
 */
export function isPublicRepoUrlEnabled(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function isValidPublicGitUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.pathname.replace(/\/+$/, '').length > 1
    );
  } catch {
    return false;
  }
}
