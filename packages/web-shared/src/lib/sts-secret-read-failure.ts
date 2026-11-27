import { claimReportWindow } from '@kilocode/web-shared/lib/ai-gateway/report-window';

/** The secrets client's `SecretUnavailableError` reasons. */
type ClientReason = 'missing' | 'not_granted' | 'denied' | 'unavailable';

/**
 * Why a selected STS read of the internal API secret failed, and the only values its failure
 * signal emits: the secrets client's own reasons, `config` for a selector or deployment mismatch,
 * `load` for a transport module that did not load, and `transport` for anything else.
 */
export type StsSecretReadFailureReason = ClientReason | 'config' | 'load' | 'transport';

const CLIENT_REASONS: Record<ClientReason, true> = {
  missing: true,
  not_granted: true,
  denied: true,
  unavailable: true,
};

function isClientReason(value: unknown): value is ClientReason {
  return typeof value === 'string' && Object.hasOwn(CLIENT_REASONS, value);
}

/** A deployment that cannot read from STS as configured: no STS environment, or a wrong issuer. */
export class StsSecretReadConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StsSecretReadConfigError';
  }
}

const loadFailures = new WeakSet<object>();

/** Marks an error as a failed transport load; the error itself is rethrown unchanged. */
export function markStsTransportLoadFailure(error: unknown): void {
  if (typeof error === 'object' && error !== null) loadFailures.add(error);
}

/**
 * The emitted reason of a failed STS read. The client's reason is matched by value, without
 * importing the client, so the light reader keeps its no-transport import graph; anything that
 * is not one of those values is `transport`. Nothing of the error is copied out.
 */
export function stsSecretReadFailureReason(error: unknown): StsSecretReadFailureReason {
  if (typeof error === 'object' && error !== null && loadFailures.has(error)) return 'load';
  if (error instanceof StsSecretReadConfigError) return 'config';
  if (error instanceof Error && 'reason' in error && isClientReason(error.reason)) {
    return error.reason;
  }
  return 'transport';
}

/**
 * The one failure signal of selected STS reads in `apps/web` and `apps/ai-gateway`: a fixed event
 * and reason, reported once per reason per report window in a process, best effort: the window's
 * shared key store can forget a key early, which reports it again. It carries no error text,
 * secret name or value, so callers keep their own generic answers and never log the failure.
 */
export function reportStsSecretReadFailure(reason: StsSecretReadFailureReason): void {
  if (!claimReportWindow(`sts-secret-read:${reason}`, Date.now())) return;
  console.warn(JSON.stringify({ event: 'sts_secret_read_failed', reason }));
}
