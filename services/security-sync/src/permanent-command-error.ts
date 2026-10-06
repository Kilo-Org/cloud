/**
 * Permanent/transient classification for Security Agent command processing.
 * A permanent failure can never succeed on redelivery — a disconnected GitHub
 * integration, a revoked installation, or a GitHub 4xx rejection — so the
 * queue handler marks the command failed with a meaningful result code
 * instead of retrying until QUEUE_RETRIES_EXHAUSTED. Everything else
 * (network errors, timeouts, 429, 5xx) stays transient and keeps the
 * existing retry behavior.
 */
export class PermanentSecurityCommandError extends Error {
  readonly resultCode: string;
  readonly lastErrorRedacted: string;

  constructor(params: { resultCode: string; lastErrorRedacted: string; cause?: unknown }) {
    super(params.lastErrorRedacted);
    this.name = 'PermanentSecurityCommandError';
    this.resultCode = params.resultCode;
    this.lastErrorRedacted = params.lastErrorRedacted;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}

export function isPermanentSecurityCommandError(
  error: unknown
): error is PermanentSecurityCommandError {
  return error instanceof PermanentSecurityCommandError;
}

/**
 * The git-token service throws GitHubInstallationAccessDeniedError when an
 * installation has no active integration association (disconnected,
 * suspended, deleted, or auth-invalid). The error crosses a Workers RPC
 * boundary, so match the preserved name instead of instanceof.
 */
export function isGitHubInstallationAccessDeniedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'GitHubInstallationAccessDeniedError';
}

const GITHUB_DISMISSAL_PERMANENT_FAILURES: ReadonlyMap<
  number,
  { resultCode: string; lastErrorRedacted: string }
> = new Map([
  [
    401,
    {
      resultCode: 'GITHUB_AUTH_INVALID',
      lastErrorRedacted:
        'GitHub rejected the dismissal because the App authorization is no longer valid',
    },
  ],
  [
    403,
    {
      resultCode: 'GITHUB_AUTH_INVALID',
      lastErrorRedacted:
        'GitHub rejected the dismissal because the App no longer has access to this repository',
    },
  ],
  [
    404,
    {
      resultCode: 'REPOSITORY_UNAVAILABLE',
      lastErrorRedacted: 'GitHub no longer exposes this repository or alert to the App',
    },
  ],
  [
    410,
    {
      resultCode: 'REPOSITORY_UNAVAILABLE',
      lastErrorRedacted: 'GitHub no longer exposes this repository or alert to the App',
    },
  ],
  [
    422,
    {
      resultCode: 'DISMISSAL_REJECTED',
      lastErrorRedacted: 'GitHub rejected the dismissal for this finding',
    },
  ],
]);

/** Null when the status is transient (429, 5xx) and delivery should retry. */
export function permanentGithubDismissalFailure(
  status: number
): { resultCode: string; lastErrorRedacted: string } | null {
  return GITHUB_DISMISSAL_PERMANENT_FAILURES.get(status) ?? null;
}
