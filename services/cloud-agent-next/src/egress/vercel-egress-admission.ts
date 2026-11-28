import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
import { hashSandboxCredential } from '../sandbox-control/credential.js';
import { configuredVercelForwardUrl } from '../scm-broker/targets.js';
import {
  providerContext,
  vercelIdentityFailure,
  verifyVercelForwardIdentity,
  type VercelAdmissionContext,
} from '../scm-broker/vercel-admission.js';
import type { VercelSandboxIdentityContract } from '../scm-broker/vercel-identity.js';
import type { vercelJwksCache } from '../scm-broker/vercel-jwks.js';
import type { fetchByocVercelCredential } from '../byoc/vercel-credential-resolver.js';
import type { Env } from '../types.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  sandboxEgressAdmissionSchema,
  type SandboxEgressAdmission,
  type SandboxEgressAdmissionResult,
} from './egress-admission.js';
import { createExpiringCache, type ExpiringCache } from './expiring-cache.js';

const IDENTITY_CACHE_ENTRIES = 64;

/** Verified identities in Durable Object memory: identity expiry in milliseconds. */
export type EgressIdentityCache = ExpiringCache<number>;

export function createEgressIdentityCache(): EgressIdentityCache {
  return createExpiringCache<number>(IDENTITY_CACHE_ENTRIES);
}

type Denial = Extract<SandboxEgressAdmissionResult, { ok: false }>;

/**
 * Admits a request to the egress proxy route of a Vercel sandbox. The policy
 * comes from the provider pin, never from the request. It reads without the
 * lifecycle queue and checks the live allocation on each call; only the
 * identity verification is cached, until the token expires or the allocation
 * changes.
 */
export async function admitVercelEgressForward(
  input: SandboxEgressAdmission,
  deps: {
    env: Env;
    /** The invocation's context, for a secret read's bundle revalidation. */
    ctx?: SecretsExecutionContext;
    contract: VercelSandboxIdentityContract | null;
    pin: { egressAllowlist?: readonly string[]; egressAudit?: boolean } | null;
    identities: EgressIdentityCache;
    readContext: () => Promise<VercelAdmissionContext>;
    fetchCredential?: typeof fetchByocVercelCredential;
    keys?: typeof vercelJwksCache;
    now?: () => number;
  }
): Promise<SandboxEgressAdmissionResult> {
  const deny = (code: string): Denial => ({ ok: false, status: 403, code });
  const parsed = sandboxEgressAdmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 401, code: 'invalid_request' };
  const allowlist = deps.pin?.egressAllowlist;
  if (allowlist === undefined) return { ok: true, policy: null };
  const now = deps.now ?? Date.now;
  const context = providerContext(await deps.readContext());
  const { allocationId, providerRef, kind } = context.allocation;
  const forwardUrl = configuredVercelForwardUrl(deps.env, context.sandboxId);
  if (
    !context.available ||
    context.ownerId === null ||
    allocationId === null ||
    providerRef === null ||
    kind === 'stopped' ||
    kind === 'stopping' ||
    forwardUrl === null
  )
    return deny('allocation_unavailable');
  const key = JSON.stringify([
    await hashSandboxCredential(parsed.data.oidcToken),
    context.ownerId,
    allocationId,
    providerRef,
    context.identityBinding,
  ]);
  let expiresAt = deps.identities.get(key, now());
  if (expiresAt === undefined) {
    try {
      const identity = await verifyVercelForwardIdentity(parsed.data.oidcToken, context, {
        ...deps,
        now,
      });
      if (!identity.ok) return identity;
      expiresAt = identity.exp * 1000;
    } catch (error) {
      return vercelIdentityFailure(error);
    }
    deps.identities.set(key, expiresAt, expiresAt);
  }
  // The Worker cannot proxy to itself: the sandbox reaches its host directly.
  const workerHost = egressDomainSchema.safeParse(new URL(forwardUrl).hostname).data;
  return {
    ok: true,
    policy: {
      allowlist: allowlist.filter(host => host !== workerHost),
      ...(deps.pin?.egressAudit === true ? { audit: { allocationRef: allocationId } } : {}),
    },
    expiresAt,
  };
}
