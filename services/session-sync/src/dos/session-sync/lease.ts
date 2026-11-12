import { LIMITS } from '../../protocol';

/** Small leases double up to the existing growth quantum. Empty sessions reserve no bytes. */
export function leaseBytes(used: number): number {
  if (used === 0) return 0;
  let quantum: number = LIMITS.tenantInitialLeaseBytes;
  while (quantum < used && quantum < LIMITS.tenantLeaseBytes) quantum *= 2;
  return Math.min(
    LIMITS.sessionBlobBytes + LIMITS.sessionInlineBytes,
    Math.ceil(used / quantum) * quantum
  );
}
