import { z } from 'zod';
import type { AgentSandboxProvider } from './types.js';
import { isSafeSandboxId } from './shared/control-plane-credential.js';
import type { ScopeGrantView } from './control-plane/sandbox/scope-view.js';

/**
 * A runtime credential proxy request's physical origin. Both variants are
 * produced from platform-trusted evidence only: native containers from the
 * installed outbound interception props, Vercel from the forwardURL request
 * plus Vercel's sandbox OIDC header. Request paths, headers and logical sandbox
 * names supplied by a caller are never authority.
 */
export const runtimeProxyContainersOriginSchema = z
  .object({
    type: z.literal('cloudflare-containers'),
    containerId: z.string().min(1).max(512),
    allocationRef: z.string().min(1).max(4096),
  })
  .strict();

export const runtimeProxyVercelOriginSchema = z
  .object({
    type: z.literal('vercel'),
    oidcToken: z.string().min(1).max(8192),
    logicalSandboxId: z.string().min(1).max(256).optional(),
  })
  .strict();

export const runtimeCredentialProxyOriginSchema = z.discriminatedUnion('type', [
  runtimeProxyContainersOriginSchema,
  runtimeProxyVercelOriginSchema,
]);

export type RuntimeProxyContainersOrigin = z.infer<typeof runtimeProxyContainersOriginSchema>;
export type RuntimeProxyVercelOrigin = z.infer<typeof runtimeProxyVercelOriginSchema>;
export type RuntimeCredentialProxyOrigin = z.infer<typeof runtimeCredentialProxyOriginSchema>;

/**
 * The authoritative control-plane allocation a runtime proxy request came from.
 * `connectionId` is retained for diagnostics only; equality uses the same
 * reconnect-safe fence as the grant itself (allocation, provider instance and
 * wrapper instance), so a same-wrapper socket reconnect does not invalidate an
 * otherwise current origin.
 */
export type RuntimeProxyControlBinding = {
  plane: 'control';
  logicalSandboxId: string;
  allocationId: string;
  provider: AgentSandboxProvider;
  providerInstanceId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

export type RuntimeProxyRuntimeAuthorization = {
  userId: string;
  authorizationId: string;
  resourceId: string;
};

/** The Session DO's origin-admitted proxy credential. */
export type OriginBoundRuntimeProxyResolution = {
  token: string;
  organizationId?: string;
  runtimeAuthorization: RuntimeProxyRuntimeAuthorization;
  scopeView?: ScopeGrantView;
  binding: RuntimeProxyControlBinding;
};

export function sameRuntimeProxyOriginBinding(
  left: RuntimeProxyControlBinding,
  right: RuntimeProxyControlBinding
): boolean {
  return (
    left.plane === right.plane &&
    left.logicalSandboxId === right.logicalSandboxId &&
    left.allocationId === right.allocationId &&
    left.provider === right.provider &&
    left.providerInstanceId === right.providerInstanceId &&
    left.wrapperInstanceId === right.wrapperInstanceId
  );
}

export const VERCEL_RUNTIME_PROXY_PATH_PREFIX = '/runtime-credential-proxy/vercel';

/** Vercel's forwardURL request header carrying the sandbox OIDC token. */
export const VERCEL_RUNTIME_PROXY_OIDC_HEADER = 'vercel-sandbox-oidc-token';

/**
 * The Vercel forwardURL and OIDC audience for one logical sandbox. Vercel's
 * network policy forwards matching sandbox traffic here and attaches the
 * sandbox OIDC token; the admission reuses the SCM RS256/JWKS verifier against
 * this exact audience.
 */
export function configuredVercelRuntimeProxyForwardUrl(
  env: { WORKER_URL?: string },
  logicalSandboxId: string
): string | null {
  if (!isSafeSandboxId(logicalSandboxId) || !env.WORKER_URL) return null;
  try {
    const base = new URL(env.WORKER_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
      return null;
    return new URL(
      `${VERCEL_RUNTIME_PROXY_PATH_PREFIX}/${encodeURIComponent(logicalSandboxId)}`,
      base
    ).href;
  } catch {
    return null;
  }
}
