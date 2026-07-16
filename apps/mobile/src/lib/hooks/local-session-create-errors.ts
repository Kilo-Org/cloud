/**
 * Bounded set of upstream codes the mobile client can branch on for the
 * `localRuntimeControl.createAndRun` mutation. Mirrors
 * `LocalRuntimeControlErrorCode` plus the server-only `SESSION_NOT_READY`
 * code that the create mutation attaches to its `session_not_ready` status
 * branch — which is not a thrown error but a typed recovery surface.
 */
type LocalSessionCreateUpstreamCode =
  | 'RUNTIME_NOT_CONNECTED'
  | 'RUNTIME_FENCE_MISMATCH'
  | 'CLI_UPGRADE_REQUIRED'
  | 'CATALOG_CHANGED'
  | 'COMMAND_ALREADY_PENDING'
  | 'PENDING_COMMAND_LIMIT'
  | 'COMMAND_EXPIRED'
  | 'RESULT_TOO_LARGE'
  | 'INVALID_RUNTIME_RESPONSE'
  | 'RUNTIME_COMMAND_FAILED'
  | 'COMMAND_NOT_ALLOWED'
  | 'SESSION_NOT_READY'
  | 'UNKNOWN';

const UPSTREAM_CODES: ReadonlySet<LocalSessionCreateUpstreamCode> = new Set([
  'RUNTIME_NOT_CONNECTED',
  'RUNTIME_FENCE_MISMATCH',
  'CLI_UPGRADE_REQUIRED',
  'CATALOG_CHANGED',
  'COMMAND_ALREADY_PENDING',
  'PENDING_COMMAND_LIMIT',
  'COMMAND_EXPIRED',
  'RESULT_TOO_LARGE',
  'INVALID_RUNTIME_RESPONSE',
  'RUNTIME_COMMAND_FAILED',
  'COMMAND_NOT_ALLOWED',
  'SESSION_NOT_READY',
  'UNKNOWN',
]);

/**
 * Recovery category for a `createAndRun` failure. The renderer maps each
 * `kind` to exactly one CTA-or-no-CTA presentation — retryable branches
 * always carry an actionable `ctaLabel`; non-retryable branches always have
 * `ctaLabel === null` so the renderer can hide the CTA without a separate
 * boolean.
 */
export type LocalSessionCreateRecovery =
  | {
      kind: 'fence-changed';
      message: string;
      ctaLabel: 'Select runtime';
    }
  | {
      kind: 'catalog-changed';
      message: string;
      ctaLabel: 'Refresh catalog';
    }
  | {
      kind: 'transient';
      message: string;
      ctaLabel: 'Retry';
    }
  | {
      kind: 'limit';
      message: string;
      ctaLabel: 'Retry';
    }
  | {
      kind: 'non-retryable-cli-upgrade';
      message: string;
      ctaLabel: null;
    }
  | {
      kind: 'non-retryable-malformed';
      message: string;
      ctaLabel: null;
    }
  | {
      kind: 'non-retryable-prompt-too-long';
      message: string;
      ctaLabel: null;
    }
  | {
      kind: 'non-retryable-prompt-empty';
      message: string;
      ctaLabel: null;
    }
  | {
      kind: 'non-retryable-access-lost';
      message: string;
      ctaLabel: null;
    }
  | {
      kind: 'readiness-timeout';
      message: string;
      ctaLabel: 'Check again';
    };

const FENCE_CHANGED_MESSAGE =
  'Local runtime disconnected. Select a connected runtime and try again.';
const CATALOG_CHANGED_MESSAGE =
  'The runtime catalog changed. Review the model and agent, then try again.';
const TRANSIENT_MESSAGE =
  "We couldn't confirm whether the session started. Retry with the same request.";
const LIMIT_MESSAGE = 'This runtime is handling too many requests. Try again in a moment.';
const CLI_UPGRADE_MESSAGE = 'Update Kilo CLI and reconnect.';
const MALFORMED_MESSAGE =
  'This runtime returned an unsupported response. Update Kilo CLI and reconnect.';
const ACCESS_LOST_MESSAGE = 'You no longer have access to this session.';
const READINESS_TIMEOUT_MESSAGE = "Session created, but it isn't ready in the app yet.";

/**
 * Classify a thrown error from the `localRuntimeControl.createAndRun`
 * mutation into the recovery branch the orchestrator must surface. The
 * classifier is exhaustive over the bounded `LocalSessionCreateUpstreamCode`
 * set and falls back to the transient Retry branch for any malformed or
 * unrecognised throwable — a network blip or a fresh server code must not
 * leave the user stuck.
 *
 * The renderer never inspects the original error: it reads `kind`,
 * `message`, and `ctaLabel` only.
 */
export function classifyLocalSessionCreateError(error: unknown): LocalSessionCreateRecovery {
  const upstreamCode = readUpstreamCode(error);
  if (upstreamCode === 'UNKNOWN' && readTrpcErrorCode(error) === 'FORBIDDEN') {
    return {
      kind: 'non-retryable-access-lost',
      message: ACCESS_LOST_MESSAGE,
      ctaLabel: null,
    };
  }
  switch (upstreamCode) {
    case 'RUNTIME_NOT_CONNECTED':
    case 'RUNTIME_FENCE_MISMATCH': {
      return { kind: 'fence-changed', message: FENCE_CHANGED_MESSAGE, ctaLabel: 'Select runtime' };
    }
    case 'CATALOG_CHANGED': {
      return {
        kind: 'catalog-changed',
        message: CATALOG_CHANGED_MESSAGE,
        ctaLabel: 'Refresh catalog',
      };
    }
    case 'COMMAND_EXPIRED':
    case 'RUNTIME_COMMAND_FAILED':
    case 'COMMAND_ALREADY_PENDING': {
      return { kind: 'transient', message: TRANSIENT_MESSAGE, ctaLabel: 'Retry' };
    }
    case 'PENDING_COMMAND_LIMIT': {
      return { kind: 'limit', message: LIMIT_MESSAGE, ctaLabel: 'Retry' };
    }
    case 'CLI_UPGRADE_REQUIRED': {
      return { kind: 'non-retryable-cli-upgrade', message: CLI_UPGRADE_MESSAGE, ctaLabel: null };
    }
    case 'RESULT_TOO_LARGE':
    case 'INVALID_RUNTIME_RESPONSE':
    case 'COMMAND_NOT_ALLOWED': {
      return { kind: 'non-retryable-malformed', message: MALFORMED_MESSAGE, ctaLabel: null };
    }
    case 'SESSION_NOT_READY': {
      return {
        kind: 'readiness-timeout',
        message: READINESS_TIMEOUT_MESSAGE,
        ctaLabel: 'Check again',
      };
    }
    case 'UNKNOWN': {
      return { kind: 'transient', message: TRANSIENT_MESSAGE, ctaLabel: 'Retry' };
    }
    default: {
      const _never: never = upstreamCode;
      void _never;
      return { kind: 'transient', message: TRANSIENT_MESSAGE, ctaLabel: 'Retry' };
    }
  }
}

/**
 * Read the upstream code out of a tRPC error envelope. Returns the bounded
 * `LocalSessionCreateUpstreamCode` union — never `null` — so the
 * classifier's switch is exhaustive.
 *
 * - A throwable with no `data` property or with a non-object `data` is
 *   treated as a transient retryable transport failure and surfaces as
 *   `'UNKNOWN'`.
 * - A throwable whose envelope carries no recognisable upstream code
 *   surfaces as `'UNKNOWN'` (a transient retry — the server was reached
 *   but the response was not a typed create failure).
 * - Every entry of the union.
 */
function readTrpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const code = (data as { code?: unknown }).code;
  if (typeof code !== 'string') {
    return undefined;
  }
  return code;
}

function readUpstreamCode(error: unknown): LocalSessionCreateUpstreamCode {
  if (!error || typeof error !== 'object') {
    return 'UNKNOWN';
  }
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return 'UNKNOWN';
  }
  const code = (data as { upstreamCode?: unknown }).upstreamCode;
  if (typeof code !== 'string') {
    return 'UNKNOWN';
  }
  if (UPSTREAM_CODES.has(code as LocalSessionCreateUpstreamCode)) {
    return code as LocalSessionCreateUpstreamCode;
  }
  return 'UNKNOWN';
}
