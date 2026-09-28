/**
 * Marker for faults injected by the E2E harness, never by app logic.
 *
 * A harness fault (injected through the secure-store fault window in
 * lib/config and lib/auth/secure-store-read) exists only to make a failure
 * state provable on a live build; when it reaches the telemetry pipeline it
 * would file a Sentry issue for a defect the product does not have. The throw
 * site tags the fault with a stable error name so every reporter can tell it
 * apart, and the Sentry `beforeSend` gate drops it.
 *
 * Pure and SDK-free so the predicate can be tested and reused by any reporter.
 */

/** Stable `Error.name` for a harness-injected fault. Never rename: reporters match on it. */
export const INJECTED_FAULT_ERROR_NAME = 'E2eInjectedFaultError';

/** Error thrown only by the E2E fault window; carries the marker name. */
export class E2eInjectedFaultError extends Error {
  override readonly name = INJECTED_FAULT_ERROR_NAME;
}

/**
 * True when `error` is a harness-injected E2E fault. Matches the class and the
 * name marker, because a fault can cross a boundary where the class identity is
 * lost (structured clone, a wrapped error) while the name survives.
 */
export function isE2eInjectedFault(error: unknown): boolean {
  if (error instanceof E2eInjectedFaultError) {
    return true;
  }
  // Untyped telemetry boundary: the captured value may be any thrown value, so
  // read the marker off a narrowed shape rather than assuming an Error.
  return (error as { name?: unknown } | null | undefined)?.name === INJECTED_FAULT_ERROR_NAME;
}
