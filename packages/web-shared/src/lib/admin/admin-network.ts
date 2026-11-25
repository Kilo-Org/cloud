import 'server-only';
import { BlockList } from 'node:net';
import { captureMessage } from '@sentry/nextjs';
import { firstForwardedHop } from '@kilocode/web-shared/lib/http/forwarded-hop';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  normalizeClientAddress,
  parseAdminAllowedNetworks,
} from '@kilocode/web-shared/lib/admin/admin-network-policy';
import {
  ADMIN_NETWORK_DENIED_CODE,
  ADMIN_NETWORK_DENIED_MESSAGE,
  ADMIN_NETWORK_NOT_CONFIGURED_CODE,
  ADMIN_NETWORK_NOT_CONFIGURED_MESSAGE,
} from '@kilocode/web-shared/lib/admin/admin-network-messages';

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

type ConfigProblem = 'not-configured' | 'invalid-config' | 'all-addresses' | 'outside-vercel';

let memoizedConfig: AdminNetworkConfig | undefined;
const reportedConfigProblems = new Set<ConfigProblem>();

/** Error-level, once per problem per process: console for logs, Sentry for alerting. */
function reportConfigProblem(problem: ConfigProblem, message: string): void {
  if (reportedConfigProblems.has(problem)) return;
  reportedConfigProblems.add(problem);
  const text = `ADMIN_ALLOWED_NETWORKS ${problem}: ${message}`;
  errorExceptInTest(text);
  captureMessage(text, { level: 'error', tags: { source: 'admin_network' } });
}

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
  if (parsed.entries.some(entry => entry.prefix === 0)) {
    reportConfigProblem(
      'all-addresses',
      'an all-addresses range is configured, so the admin network check admits every address'
    );
  }
  return { kind: 'configured', allowlist };
}

/** Test-only: forget the parsed list so the next call rereads the environment. */
export function resetAdminNetworkConfigForTest(): void {
  memoizedConfig = undefined;
  reportedConfigProblems.clear();
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
 * Whether the request may reach an admin surface from its network. Local
 * development, tests and scripts are `skipped`: `VERCEL` unset, `NODE_ENV` not
 * `production`, and `VERCEL_ENV` unset or `development` (the value `vercel env
 * pull` and `.env.test` carry; a deployment is `production` or `preview`).
 * Anything that looks deployed enforces. When enforced, a missing, empty or
 * invalid list, or a request without `x-vercel-forwarded-for`, is denied.
 */
export function adminNetworkDecision(headersList: Headers): AdminNetworkDecision {
  const vercelEnv = process.env.VERCEL_ENV;
  if (
    !process.env.VERCEL &&
    (!vercelEnv || vercelEnv === 'development') &&
    process.env.NODE_ENV !== 'production'
  ) {
    return { kind: 'skipped' };
  }
  if (!process.env.VERCEL) {
    reportConfigProblem(
      'outside-vercel',
      'enforced without VERCEL set; only Vercel guarantees x-vercel-forwarded-for'
    );
  }
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
  /** Stable code for clients that branch on the refusal. */
  code: typeof ADMIN_NETWORK_DENIED_CODE | typeof ADMIN_NETWORK_NOT_CONFIGURED_CODE;
  message: string;
};

export function adminNetworkRefusalFor(reason: AdminNetworkDenialReason): AdminNetworkRefusal {
  return reason === 'no-client-address' || reason === 'outside-allowlist'
    ? {
        reason,
        retryable: true,
        code: ADMIN_NETWORK_DENIED_CODE,
        message: ADMIN_NETWORK_DENIED_MESSAGE,
      }
    : {
        reason,
        retryable: false,
        code: ADMIN_NETWORK_NOT_CONFIGURED_CODE,
        message: ADMIN_NETWORK_NOT_CONFIGURED_MESSAGE,
      };
}

export type AdminNetworkRequest = {
  route: string | null;
  kiloUserId: string;
};

function reportDenial(
  reason: AdminNetworkDenialReason,
  headersList: Headers,
  request: AdminNetworkRequest
) {
  if (reason === 'not-configured' || reason === 'invalid-config') {
    const detail = memoizedConfig?.kind === 'invalid-config' ? `${memoizedConfig.message}; ` : '';
    reportConfigProblem(reason, `${detail}every admin request is refused`);
  }
  warnExceptInTest(
    JSON.stringify({
      event: 'admin_network_denied',
      reason,
      route: request.route,
      kiloUserId: request.kiloUserId,
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
  request: AdminNetworkRequest
): AdminNetworkRefusal | null {
  const decision = adminNetworkDecision(headersList);
  if (decision.kind !== 'denied') return null;
  reportDenial(decision.reason, headersList, request);
  return adminNetworkRefusalFor(decision.reason);
}
