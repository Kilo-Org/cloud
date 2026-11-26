/**
 * Raise when a secret cannot be read. `retryable` tells the caller whether serving its
 * last good value (or retrying later) can help; a non-retryable read needs an identity or
 * policy change first.
 */
export type SecretUnavailableReason = 'missing' | 'not_granted' | 'denied' | 'unavailable';

const RETRYABLE: Record<SecretUnavailableReason, boolean> = {
  missing: false,
  not_granted: false,
  denied: false,
  unavailable: true,
};

function describe(reason: SecretUnavailableReason, secretName: string | undefined): string {
  const named = secretName === undefined ? 'Secret' : `Secret "${secretName}"`;
  switch (reason) {
    case 'missing':
      return `${named} is missing from the bundle: the policy grants it and the manager holds no value`;
    case 'not_granted':
      return `${named} is not granted to this workload`;
    case 'denied':
      return 'STS denied the bundle request for this workload';
    case 'unavailable':
      return 'STS did not return a usable bundle';
  }
}

export class SecretUnavailableError extends Error {
  readonly reason: SecretUnavailableReason;
  readonly retryable: boolean;

  constructor(
    reason: SecretUnavailableReason,
    options: { secretName?: string; cause?: unknown } = {}
  ) {
    super(
      describe(reason, options.secretName),
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = 'SecretUnavailableError';
    this.reason = reason;
    this.retryable = RETRYABLE[reason];
  }
}
