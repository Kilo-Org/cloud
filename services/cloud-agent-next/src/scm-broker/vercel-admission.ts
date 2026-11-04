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

function providerContext(context: VercelAdmissionContext) {
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

export async function admitVercelScmForward(
  input: ControlPlaneScmForwardAdmission,
  deps: {
    env: Env;
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
  const deny = (
    code: string,
    status: 401 | 403 | 503 = 403
  ): Extract<ControlPlaneScmForwardAdmissionResult, { ok: false }> => ({ ok: false, status, code });
  const parsed = controlPlaneScmForwardAdmissionSchema.safeParse(input);
  if (!parsed.success) return deny('invalid_request', 401);
  input = parsed.data;
  const now = deps.now ?? Date.now;
  try {
    return await admitScmRequest(input, {
      ...deps,
      readContext: async () => providerContext(await deps.readContext()),
      authenticate: async context => {
        if (!context.byoc || !context.locator) return deny('allocation_unavailable');
        const audience = configuredVercelForwardUrl(deps.env, context.sandboxId);
        const providerRef = decodeVercelProviderRef(context.allocation.providerRef);
        if (!audience || !providerRef) return deny('allocation_unavailable');
        if (!deps.contract) return deny('provider_identity_mismatch', 503);
        const credential = await (deps.fetchCredential ?? fetchByocVercelCredential)(
          deps.env,
          context.byoc
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
        const identity = await authenticateVercelForwardToken(
          input.oidcToken,
          expected,
          deps.keys,
          now()
        );
        return identity
          ? { ok: true, isCurrent: () => identity.exp > now() / 1000 }
          : deny('invalid_identity', 401);
      },
    });
  } catch (error) {
    if (error instanceof OidcKeysUnavailable)
      return { ok: false, status: 503, code: error.code, retryAfter: error.retryAfter };
    return deny('byoc_unavailable', 503);
  }
}
