import 'server-only';
import { BlockList } from 'node:net';
import { captureMessage } from '@sentry/nextjs';
import { firstForwardedHop } from '@kilocode/web-shared/lib/http/forwarded-hop';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  normalizeClientAddress,
  parseAdminAllowedNetworks,
} from '@kilocode/web-shared/lib/admin/admin-network-policy';

export type AdminNetworkDenialReason =
  | 'not-configured'
  | 'invalid-config'
  | 'no-client-address'
  | 'outside-allowlist';

export type AdminNetworkDecision =
  | { kind: 'allowed' }
  | { kind: 'skipped' }
  | { kind: 'denied'; reason: AdminNetworkDenialReason };

type AdminNetworkConfig =
  | { kind: 'configured'; allowlist: BlockList }
  | { kind: 'not-configured' }
  | { kind: 'invalid-config'; message: string };

let memoizedConfig: AdminNetworkConfig | undefined;
const reportedConfigErrors = new Set<AdminNetworkDenialReason>();

function loadConfig(): AdminNetworkConfig {
  const parsed = parseAdminAllowedNetworks(process.env.ADMIN_ALLOWED_NETWORKS);
  if (parsed.kind === 'empty') return { kind: 'not-configured' };
  if (parsed.kind === 'invalid') return { kind: 'invalid-config', message: parsed.message };
  const allowlist = new BlockList();
  for (const entry of parsed.entries) {
    if (entry.prefix === null) {
      allowlist.addAddress(entry.address, entry.family);
    } else {
      allowlist.addSubnet(entry.address, entry.prefix, entry.family);
    }
  }
  return { kind: 'configured', allowlist };
}

/** Test-only: forget the parsed list so the next call rereads the environment. */
export function resetAdminNetworkConfigForTest(): void {
  memoizedConfig = undefined;
  reportedConfigErrors.clear();
}

/**
 * The address Vercel observed. Clients can set `x-forwarded-for` and
 * `x-real-ip` themselves, so neither is read; Vercel overwrites
 * `x-vercel-forwarded-for` at its edge.
 */
function vercelClientAddress(headersList: Headers) {
  const hop = firstForwardedHop(headersList.get('x-vercel-forwarded-for'));
  return hop === null ? null : normalizeClientAddress(hop);
}

/**
 * Whether the request may reach an admin surface from its network. Enforced
 * only on Vercel, the one place the client address header is trustworthy;
 * local development, tests and scripts are `skipped`. On Vercel a missing,
 * empty or invalid list denies every admin request.
 */
export function adminNetworkDecision(headersList: Headers): AdminNetworkDecision {
  if (!process.env.VERCEL) return { kind: 'skipped' };
  memoizedConfig ??= loadConfig();
  if (memoizedConfig.kind !== 'configured') {
    return { kind: 'denied', reason: memoizedConfig.kind };
  }
  const client = vercelClientAddress(headersList);
  if (client === null) return { kind: 'denied', reason: 'no-client-address' };
  return memoizedConfig.allowlist.check(client.address, client.family)
    ? { kind: 'allowed' }
    : { kind: 'denied', reason: 'outside-allowlist' };
}

export type AdminNetworkRefusal = {
  reason: AdminNetworkDenialReason;
  /** True when connecting to the corporate network and retrying can succeed. */
  retryable: boolean;
  message: string;
};

const OFF_NETWORK_MESSAGE =
  'Admin access is limited to the corporate network. Connect to Cloudflare WARP, then try again.';
const NOT_CONFIGURED_MESSAGE =
  'Admin access is unavailable because the admin network allowlist is not configured for this deployment.';

export function adminNetworkRefusalFor(reason: AdminNetworkDenialReason): AdminNetworkRefusal {
  const retryable = reason === 'no-client-address' || reason === 'outside-allowlist';
  return { reason, retryable, message: retryable ? OFF_NETWORK_MESSAGE : NOT_CONFIGURED_MESSAGE };
}

function reportDenial(
  reason: AdminNetworkDenialReason,
  headersList: Headers,
  route: string | null
) {
  if (reason === 'not-configured' || reason === 'invalid-config') {
    if (reportedConfigErrors.has(reason)) return;
    reportedConfigErrors.add(reason);
    const detail = memoizedConfig?.kind === 'invalid-config' ? `: ${memoizedConfig.message}` : '';
    const message = `ADMIN_ALLOWED_NETWORKS ${reason}${detail}; every admin request is refused`;
    errorExceptInTest(message);
    captureMessage(message, { level: 'error', tags: { source: 'admin_network' } });
    return;
  }
  warnExceptInTest(
    JSON.stringify({
      event: 'admin_network_denied',
      reason,
      route,
      ip: vercelClientAddress(headersList)?.address ?? null,
    })
  );
}

/**
 * The one network check both admin guards call once the caller is known to be
 * an admin. Null when the request may proceed; otherwise the refusal the guard
 * turns into its 403 or tRPC FORBIDDEN.
 */
export function adminNetworkRefusal(
  headersList: Headers,
  route: string | null
): AdminNetworkRefusal | null {
  const decision = adminNetworkDecision(headersList);
  if (decision.kind !== 'denied') return null;
  reportDenial(decision.reason, headersList, route);
  return adminNetworkRefusalFor(decision.reason);
}
