/**
 * Shared error classification for the PR/MR review layer.
 *
 * The classified failure `kind` is the mobile error-state contract: the
 * provider authorization adapters (GitLab, Bitbucket) classify every
 * failure into this union, and the router maps it onto tRPC codes. The kind
 * vocabulary, the retryable derivation, and the network-failure probe are
 * provider-independent, so they live here next to the rest of the
 * provider-review vocabulary: a new state is added in exactly one place,
 * while the copy that names a provider stays in its adapter.
 */

export type ProviderReviewErrorKind =
  | 'not_found'
  | 'forbidden'
  | 'reconnect'
  | 'stale_head'
  | 'bad_request'
  | 'retryable';

/**
 * A classified provider failure. `retryable` is true only for 5xx/network
 * outcomes. The message is fixed copy that never embeds a token or an
 * identity, so every output of this layer is safe to show or log.
 */
export class ProviderReviewError extends Error {
  readonly kind: ProviderReviewErrorKind;
  readonly retryable: boolean;

  constructor(kind: ProviderReviewErrorKind, message: string) {
    super(message);
    this.name = 'ProviderReviewError';
    this.kind = kind;
    this.retryable = kind === 'retryable';
  }
}

/** An HTTP failure raised by a provider adapter's own JSON requests. */
export class ProviderApiStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ProviderApiStatusError';
  }
}

export function isNetworkFailure(error: Error): boolean {
  return (
    error.name === 'TypeError' ||
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error.message.toLowerCase().includes('fetch failed')
  );
}
