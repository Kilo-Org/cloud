import type { MintDeniedReason } from '@kilocode/sts-contracts';

/**
 * Why STS refused a token: a per-token mint reason, or a whole-call refusal of the caller's
 * identity or request. A denial needs a policy, identity or code change; waiting does not help.
 */
export type ServiceTokenDeniedReason = MintDeniedReason | 'identity_rejected' | 'invalid_request';

export type ServiceTokenErrorDetail =
  | { reason: 'denied'; deniedReason: ServiceTokenDeniedReason }
  | { reason: 'unavailable'; retryAfterSeconds: number };

function describe(detail: ServiceTokenErrorDetail, audience: string, scope: string): string {
  return detail.reason === 'denied'
    ? `STS denied the ${scope} token for ${audience}: ${detail.deniedReason}`
    : `STS gave no usable ${scope} token for ${audience}; retry in ${detail.retryAfterSeconds} s`;
}

/**
 * Raised when `tokens.get` cannot return a token. The reason is closed: `denied` with the mint
 * reason, or `unavailable` with the seconds after which a new attempt may succeed. The message and
 * fields never carry a token.
 */
export class ServiceTokenError extends Error {
  readonly reason: ServiceTokenErrorDetail['reason'];
  readonly deniedReason: ServiceTokenDeniedReason | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly audience: string;
  readonly scope: string;

  constructor(
    detail: ServiceTokenErrorDetail,
    target: { audience: string; scope: string },
    options: { cause?: unknown } = {}
  ) {
    super(
      describe(detail, target.audience, target.scope),
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = 'ServiceTokenError';
    this.reason = detail.reason;
    this.deniedReason = detail.reason === 'denied' ? detail.deniedReason : undefined;
    this.retryAfterSeconds = detail.reason === 'unavailable' ? detail.retryAfterSeconds : undefined;
    this.audience = target.audience;
    this.scope = target.scope;
  }
}
