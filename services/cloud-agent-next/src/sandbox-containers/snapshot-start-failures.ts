import type { SnapshotStartFailureReason } from '../sandbox-control/snapshots.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/**
 * Map a provider start error to a stable reason. Only a clear signal is
 * permanent: timeouts, container stops and ambiguous probe failures stay
 * transient so the same snapshot is retried. Nothing here logs the error text.
 */
export function classifySnapshotStartFailure(error: unknown): SnapshotStartFailureReason {
  const text = `${codeOf(error)} ${messageOf(error)}`;
  if (/provenance|integrity|checksum|corrupt|digest|tamper/i.test(text)) return 'provenance';
  if (/expired?\b/i.test(text)) return 'expired';
  if (/not[ _]found|no[ _]such|missing|does[ _]not[ _]exist|unknown[ _]snapshot/i.test(text))
    return 'missing';
  if (/image/i.test(text) && /mismatch|incompatible|differ|not match/i.test(text))
    return 'image_mismatch';
  return 'transient';
}
