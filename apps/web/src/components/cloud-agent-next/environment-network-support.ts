import {
  getSandboxAllocationProvider,
  type SelectableSandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  egressRequestSupported,
  providerSupports,
} from '@kilocode/worker-utils/sandbox-provider-capabilities';
import type { NetworkAccessMode } from './environment-form';

/**
 * Advisory guidance for a restricted network mode on the draft allocation. The
 * session start applies the same shared rule (`egressRequestSupported`) and
 * refuses a sandbox that cannot enforce the mode.
 */
export function describeRestrictionSupport(
  mode: NetworkAccessMode,
  allocation: SelectableSandboxAllocation | null
): string | null {
  if (mode === 'full') return null;
  if (!allocation) {
    return 'The default sandbox may not support restricted network access. If it does not, sessions will fail to start.';
  }
  const provider = getSandboxAllocationProvider(allocation);
  if (!egressRequestSupported(provider, { egressMode: 'allowlist' })) {
    return 'This sandbox cannot restrict network access, so sessions will fail to start.';
  }
  if (providerSupports(provider, 'egressProxySeesAll')) return null;
  return 'On this sandbox, plain http:// requests fail; use https://. A domain that is not allowed does not resolve, and the egress audit does not record it. The egress audit records requests only in None or Limited mode.';
}
