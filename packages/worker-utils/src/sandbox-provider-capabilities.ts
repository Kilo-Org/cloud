import type { EgressMode } from './egress-allowlist';

/**
 * Sandbox provider ids. The allocation catalog (`sandbox-allocation.ts`)
 * returns its provider ids as this type, so the compiler rejects a catalog
 * provider without a table entry. This module imports nothing from
 * the catalog, to keep the dependency one-way.
 */
export type SandboxProviderId = 'cloudflare' | 'vercel' | 'cloudflare-containers';

/**
 * Product features that a sandbox provider can support. Parity between
 * providers is measured on this list, so it holds features only, not
 * provider facts such as labels or credential transport.
 *
 * - `egressProxy`: sandbox egress reaches the Worker egress proxy with a
 *   verified sandbox identity, so the proxy can enforce an allowlist.
 * - `egressProxySeesAll`: the proxy sees all HTTP(S) egress, not only the
 *   listed hosts, so it can audit a session without an allowlist.
 */
export const SANDBOX_PROVIDER_FEATURES = [
  'preview',
  'workspaceSnapshots',
  'environmentSnapshots',
  'egressProxy',
  'egressProxySeesAll',
  'scmCliTools',
  'meteredBilling',
] as const;

export type SandboxProviderFeature = (typeof SANDBOX_PROVIDER_FEATURES)[number];

/**
 * The one owner of provider feature support. Feature gates in the Worker and
 * the web app read this table instead of comparing provider names. The
 * Record types make the compiler reject a provider or a feature without an
 * entry. The cloud-agent-next gap test lists every `false` entry with a reason.
 */
export const SANDBOX_PROVIDER_CAPABILITIES: Readonly<
  Record<SandboxProviderId, Readonly<Record<SandboxProviderFeature, boolean>>>
> = {
  cloudflare: {
    preview: false,
    workspaceSnapshots: false,
    environmentSnapshots: false,
    egressProxy: false,
    egressProxySeesAll: false,
    scmCliTools: true,
    meteredBilling: false,
  },
  vercel: {
    preview: true,
    workspaceSnapshots: false,
    environmentSnapshots: true,
    egressProxy: false,
    egressProxySeesAll: false,
    scmCliTools: true,
    meteredBilling: false,
  },
  'cloudflare-containers': {
    preview: true,
    workspaceSnapshots: true,
    environmentSnapshots: true,
    egressProxy: true,
    egressProxySeesAll: true,
    scmCliTools: true,
    meteredBilling: true,
  },
};

export function providerSupports(
  provider: SandboxProviderId,
  feature: SandboxProviderFeature
): boolean {
  // A rolled-back stored pin or a stale client bundle can carry an unknown id: it supports nothing.
  return SANDBOX_PROVIDER_CAPABILITIES[provider]?.[feature] ?? false;
}

/** The egress fields of a session request, as `egressPolicySchema` carries them. */
export type EgressRequest = {
  egressMode?: EgressMode | undefined;
  egressAudit?: boolean | undefined;
};

/**
 * Whether a provider can enforce a session's egress request. An allowlist
 * needs the egress proxy. An audit without an allowlist needs a proxy that
 * sees all egress. A session without an egress request is always supported.
 * Every egress gate, the web guidance and the saved-allocation skip read this
 * one rule.
 */
export function egressRequestSupported(
  provider: SandboxProviderId,
  request: EgressRequest
): boolean {
  if (request.egressMode === 'allowlist') return providerSupports(provider, 'egressProxy');
  if (request.egressAudit === true) return providerSupports(provider, 'egressProxySeesAll');
  return true;
}
