/**
 * Stable upstream code surfaced by the server via `error.data.upstreamCode`.
 * Each value is a string code from the bounded
 * `LocalRuntimeControlErrorCode` enum (or `UNKNOWN`).
 */
type LocalRuntimeCatalogUpstreamCode =
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
  | 'UNKNOWN';

/**
 * Classify a `localRuntimeControl.getCatalog` error into the recovery branch
 * the configuration screen must render. The renderer never falls back to a
 * generic error — every code maps to exactly one branch.
 *
 * - `non-retryable-capability` — the runtime is missing `catalog.v1` (or any
 *   of the other required capabilities). The Retry button is suppressed and
 *   the runtime row in the picker is disabled with the existing update copy.
 * - `non-retryable-malformed` — the catalog failed strict validation
 *   (`INVALID_RUNTIME_RESPONSE`, `RESULT_TOO_LARGE`, `UNKNOWN`) or the
 *   runtime shipped a default agent that does not exist in `agents`. The user
 *   must change runtimes; retrying will not help.
 * - `retryable` — every other upstream code, plus any non-upstream throw
 *   (network error, timeouts, generic 5xx). The user can Retry or change
 *   runtimes.
 */
export function classifyLocalRuntimeCatalogError(
  error: unknown
):
  | { kind: 'non-retryable-capability'; title: string; message: string }
  | { kind: 'non-retryable-malformed'; title: string; message: string }
  | { kind: 'retryable'; title: string; message: string } {
  const upstreamCode = readUpstreamCode(error);
  if (upstreamCode === 'CLI_UPGRADE_REQUIRED') {
    return {
      kind: 'non-retryable-capability',
      title: 'Update Kilo CLI',
      message: 'Update Kilo CLI and reconnect.',
    };
  }
  if (
    upstreamCode === 'INVALID_RUNTIME_RESPONSE' ||
    upstreamCode === 'RESULT_TOO_LARGE' ||
    upstreamCode === 'UNKNOWN'
  ) {
    return {
      kind: 'non-retryable-malformed',
      title: "Couldn't load runtime catalog",
      message: "This runtime can't provide a usable catalog.",
    };
  }
  // `upstreamCode === null` covers plain network / timeout / generic-load
  // errors that never produced a typed envelope — those are always retryable.
  return {
    kind: 'retryable',
    title: "Couldn't load runtime catalog",
    message: 'Check that kilo remote is still connected, then try again.',
  };
}

/**
 * Pull the upstream code out of a tRPC error's `data` field. Returns
 * three distinct outcomes:
 *
 * - `null` — the throwable is not even tRPC-shaped (no `data` property),
 *   e.g. a plain network `Error`. The classifier treats this as a generic
 *   retryable transport failure.
 * - `'UNKNOWN'` — the throwable is tRPC-shaped but the envelope carried no
 *   recognizable upstream code. This is a structured failure (we know we
 *   reached the server) but the response was malformed.
 * - a known code — every value of `LocalRuntimeControlErrorCode`.
 */
function readUpstreamCode(error: unknown): LocalRuntimeCatalogUpstreamCode | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const code = (data as { upstreamCode?: unknown }).upstreamCode;
  if (typeof code !== 'string') {
    // tRPC-shaped throwable without a recognizable upstream code — treat as
    // a malformed response.
    return 'UNKNOWN';
  }
  switch (code) {
    case 'RUNTIME_NOT_CONNECTED':
    case 'RUNTIME_FENCE_MISMATCH':
    case 'CLI_UPGRADE_REQUIRED':
    case 'CATALOG_CHANGED':
    case 'COMMAND_ALREADY_PENDING':
    case 'PENDING_COMMAND_LIMIT':
    case 'COMMAND_EXPIRED':
    case 'RESULT_TOO_LARGE':
    case 'INVALID_RUNTIME_RESPONSE':
    case 'RUNTIME_COMMAND_FAILED':
    case 'COMMAND_NOT_ALLOWED':
    case 'UNKNOWN': {
      return code;
    }
    default: {
      return 'UNKNOWN';
    }
  }
}
