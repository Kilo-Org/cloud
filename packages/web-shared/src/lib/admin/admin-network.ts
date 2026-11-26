import 'server-only';
import { BlockList } from 'node:net';
import { captureMessage } from '@sentry/nextjs';
import { firstForwardedHop } from '@kilocode/web-shared/lib/http/forwarded-hop';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  normalizeClientAddress,
  parseAdminAllowedNetworks,
  type AdminNetworkFamily,
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
  | 'untrusted-ingress'
  | 'no-client-address'
  | 'outside-allowlist';

/**
 * `clientAddress` on a denial is the address the check validated from
 * `x-vercel-forwarded-for`, or null when the decision read none. A denial's
 * audit record takes the address from here, never from a client-settable
 * header.
 */
export type AdminNetworkDecision =
  | { kind: 'allowed' }
  | { kind: 'skipped' }
  | { kind: 'denied'; reason: AdminNetworkDenialReason; clientAddress: string | null };

type AdminNetworkDenial = Extract<AdminNetworkDecision, { kind: 'denied' }>;

/**
 * One list per family. Node's `BlockList` checks an IPv4 address against an
 * IPv6 subnet as its IPv4-mapped form, so in one shared list an IPv6 range
 * that contains `::ffff:0:0/96` (`::/0`, `::/80`) would admit every IPv4
 * client. Mapped entries and mapped client addresses are normalized to IPv4,
 * so each address is checked against its own family only.
 */
type AdminNetworkAllowlist = Record<AdminNetworkFamily, BlockList>;

type AdminNetworkConfig =
  | { kind: 'configured'; allowlist: AdminNetworkAllowlist }
  | { kind: 'not-configured' }
  | { kind: 'invalid-config'; message: string };

type ConfigProblem = 'not-configured' | 'invalid-config' | 'broad-range' | 'outside-vercel';

/** Any configured range broader than these prefixes is reported as an error. */
const BROAD_RANGE_MAX_PREFIX = { ipv4: 8, ipv6: 32 } as const;

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
  const allowlist: AdminNetworkAllowlist = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const entry of parsed.entries) {
    const familyList = allowlist[entry.family];
    if (entry.prefix === null) {
      familyList.addAddress(entry.address, entry.family);
    } else {
      familyList.addSubnet(entry.address, entry.prefix, entry.family);
    }
  }
  if (
    parsed.entries.some(
      entry => entry.prefix !== null && entry.prefix < BROAD_RANGE_MAX_PREFIX[entry.family]
    )
  ) {
    reportConfigProblem(
      'broad-range',
      'a range broader than /8 (IPv4) or /32 (IPv6) is configured, so the admin network check admits a very large address space'
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
 * Anything that looks deployed enforces. When enforced, a runtime outside
 * Vercel (where nothing overwrites a client-sent `x-vercel-forwarded-for`), a
 * missing, empty or invalid list, or a request without
 * `x-vercel-forwarded-for`, is denied.
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
      'enforced without VERCEL set; only Vercel guarantees x-vercel-forwarded-for, so every admin request is refused'
    );
    return { kind: 'denied', reason: 'untrusted-ingress', clientAddress: null };
  }
  memoizedConfig ??= loadConfig();
  if (memoizedConfig.kind !== 'configured') {
    return { kind: 'denied', reason: memoizedConfig.kind, clientAddress: null };
  }
  const client = vercelClientAddress(headersList);
  if (client === null) return { kind: 'denied', reason: 'no-client-address', clientAddress: null };
  return memoizedConfig.allowlist[client.family].check(client.address, client.family)
    ? { kind: 'allowed' }
    : { kind: 'denied', reason: 'outside-allowlist', clientAddress: client.address };
}

export type AdminNetworkRefusal = {
  reason: AdminNetworkDenialReason;
  /** Stable error code the step-up route returns for the refusal. */
  code: typeof ADMIN_NETWORK_DENIED_CODE | typeof ADMIN_NETWORK_NOT_CONFIGURED_CODE;
  message: string;
};

export function adminNetworkRefusalFor(reason: AdminNetworkDenialReason): AdminNetworkRefusal {
  return reason === 'no-client-address' || reason === 'outside-allowlist'
    ? {
        reason,
        code: ADMIN_NETWORK_DENIED_CODE,
        message: ADMIN_NETWORK_DENIED_MESSAGE,
      }
    : {
        reason,
        code: ADMIN_NETWORK_NOT_CONFIGURED_CODE,
        message: ADMIN_NETWORK_NOT_CONFIGURED_MESSAGE,
      };
}

export type AdminNetworkRequest = {
  route: string | null;
  kiloUserId: string;
};

function reportDenial(denial: AdminNetworkDenial, request: AdminNetworkRequest) {
  if (denial.reason === 'not-configured' || denial.reason === 'invalid-config') {
    const detail = memoizedConfig?.kind === 'invalid-config' ? `${memoizedConfig.message}; ` : '';
    reportConfigProblem(denial.reason, `${detail}every admin request is refused`);
  }
  warnExceptInTest(
    JSON.stringify({
      event: 'admin_network_denied',
      reason: denial.reason,
      route: request.route,
      kiloUserId: request.kiloUserId,
      ip: denial.clientAddress,
    })
  );
}

/**
 * The one network check both admin guards call once the caller is known to be
 * an admin. Null when the request may proceed; otherwise the refusal the guard
 * turns into its 403 or tRPC FORBIDDEN, with the validated client address its
 * audit record carries.
 */
export function adminNetworkRefusal(
  headersList: Headers,
  request: AdminNetworkRequest
): (AdminNetworkRefusal & Pick<AdminNetworkDenial, 'clientAddress'>) | null {
  const decision = adminNetworkDecision(headersList);
  if (decision.kind !== 'denied') return null;
  reportDenial(decision, request);
  return { ...adminNetworkRefusalFor(decision.reason), clientAddress: decision.clientAddress };
}
