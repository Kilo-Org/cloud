import type { AllocationState } from '../control-plane/sandbox/allocation.js';
import type { ByocVercelSource } from '../byoc/vercel-provider.js';
import { fetchByocVercelCredential } from '../byoc/vercel-credential-resolver.js';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import {
  decodeVercelProviderRef,
  type VercelProviderLocator,
} from '../sandbox-control/vercel-provider.js';
import {
  controlPlaneScmForwardAdmissionSchema,
  type ControlPlaneScmForwardAdmission,
  type ControlPlaneScmForwardAdmissionResult,
} from '../shared/control-plane-protocol.js';
import type { AgentSandboxProvider, Env } from '../types.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import { withDORetry } from '../utils/do-retry.js';
import { configuredVercelForwardUrl } from './targets.js';
import { admitScmRequest } from './admission.js';
import {
  authenticateVercelForwardToken,
  expectedVercelIdentity,
  type VercelSandboxIdentityContract,
} from './vercel-identity.js';
import { OidcKeysUnavailable, type vercelJwksCache } from './vercel-jwks.js';

export type VercelAdmissionContext = {
  sandboxId: string;
  ownerId: string | null;
  provider: AgentSandboxProvider;
  containmentEnabled: boolean;
  allocation: Pick<AllocationState, 'kind' | 'allocationId' | 'providerRef'>;
  physicalName: string;
  outboundContainerId: string | null;
  byoc?: ByocVercelSource;
  locator: VercelProviderLocator | null;
  grants: readonly SessionCredentialGrant[];
  liveSessionIds: readonly string[];
};

type AdmissionDenial = Extract<ControlPlaneScmForwardAdmissionResult, { ok: false }>;

export function providerContext(context: VercelAdmissionContext) {
  return {
    ...context,
    available:
      context.provider === 'vercel' &&
      context.byoc !== undefined &&
      context.locator !== null &&
      (context.byoc.userId === undefined || context.byoc.userId === context.ownerId),
    organizationId: context.byoc?.organizationId,
    identityBinding: JSON.stringify([context.physicalName, context.byoc, context.locator]),
  };
}

export function admitVercelScmForwardAtLocator(
  env: Pick<Env, 'SANDBOX_CONTROL'>,
  logicalSandboxId: string,
  input: ControlPlaneScmForwardAdmission
): Promise<ControlPlaneScmForwardAdmissionResult> {
  if (!isSafeSandboxId(logicalSandboxId))
    return Promise.resolve({ ok: false, status: 403, code: 'allocation_unavailable' });
  return withDORetry(
    () => env.SANDBOX_CONTROL.getByName(logicalSandboxId),
    async stub => await stub.admitScmForward(input),
    'admitScmForward'
  );
}

type VercelIdentityDependencies = {
  env: Env;
  /** The invocation's context, for a secret read's bundle revalidation. */
  ctx?: SecretsExecutionContext;
  contract: VercelSandboxIdentityContract | null;
  fetchCredential?: typeof fetchByocVercelCredential;
  keys?: typeof vercelJwksCache;
  now: () => number;
};

/**
 * Verifies that an OIDC token names this allocation's Vercel sandbox and this
 * forward URL. It returns the token expiry in seconds.
 */
export async function verifyVercelForwardIdentity(
  oidcToken: string,
  context: Pick<
    VercelAdmissionContext,
    'sandboxId' | 'byoc' | 'locator' | 'allocation' | 'physicalName'
  >,
  deps: VercelIdentityDependencies
): Promise<{ ok: true; exp: number } | AdmissionDenial> {
  const deny = (code: string, status: 401 | 403 | 503 = 403): AdmissionDenial => ({
    ok: false,
    status,
    code,
  });
  if (!context.byoc || !context.locator) return deny('allocation_unavailable');
  const audience = configuredVercelForwardUrl(deps.env, context.sandboxId);
  const providerRef = decodeVercelProviderRef(context.allocation.providerRef);
  if (!audience || !providerRef) return deny('allocation_unavailable');
  if (!deps.contract) return deny('provider_identity_mismatch', 503);
  const credential = await (deps.fetchCredential ?? fetchByocVercelCredential)(
    deps.env,
    context.byoc,
    deps.ctx
  );
  const expected = expectedVercelIdentity({
    credential,
    locator: context.locator,
    providerRef,
    physicalName: context.physicalName,
    audience,
    contract: deps.contract,
  });
  if (!expected) return deny('provider_identity_mismatch', 503);
  const identity = await authenticateVercelForwardToken(oidcToken, expected, deps.keys, deps.now());
  return identity ? { ok: true, exp: identity.exp } : deny('invalid_identity', 401);
}

/** Maps a provider account or key-service failure during identity verification. */
export function vercelIdentityFailure(error: unknown): AdmissionDenial {
  if (error instanceof OidcKeysUnavailable)
    return { ok: false, status: 503, code: error.code, retryAfter: error.retryAfter };
  return { ok: false, status: 503, code: 'byoc_unavailable' };
}

export async function admitVercelScmForward(
  input: ControlPlaneScmForwardAdmission,
  deps: {
    env: Env;
    /** The invocation's context, for a secret read's bundle revalidation. */
    ctx?: SecretsExecutionContext;
    contract: VercelSandboxIdentityContract | null;
    serial: <T>(operation: () => Promise<T>) => Promise<T>;
    readContext: () => Promise<VercelAdmissionContext>;
    resolve: (input: {
      grant: SessionCredentialGrant;
      credential: string;
      url: string;
      method: string;
      outboundContainerId: string;
    }) => Promise<{
      grant: SessionCredentialGrant;
      credential: string;
    } | null>;
    persist: (grant: SessionCredentialGrant) => void;
    fetchCredential?: typeof fetchByocVercelCredential;
    keys?: typeof vercelJwksCache;
    now?: () => number;
  }
): Promise<ControlPlaneScmForwardAdmissionResult> {
  const parsed = controlPlaneScmForwardAdmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 401, code: 'invalid_request' };
  input = parsed.data;
  const now = deps.now ?? Date.now;
  try {
    return await admitScmRequest(input, {
      ...deps,
      readContext: async () => providerContext(await deps.readContext()),
      authenticate: async context => {
        const identity = await verifyVercelForwardIdentity(input.oidcToken, context, {
          ...deps,
          now,
        });
        return identity.ok ? { ok: true, isCurrent: () => identity.exp > now() / 1000 } : identity;
      },
    });
  } catch (error) {
    return vercelIdentityFailure(error);
  }
}
