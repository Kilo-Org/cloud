import type { AllocationState } from './allocation.js';
import type { ByocVercelSource } from '../../byoc/vercel-provider.js';
import {
  fetchByocVercelCredential,
  type ByocVercelCredential,
} from '../../byoc/vercel-credential-resolver.js';
import {
  decodeVercelProviderRef,
  type VercelProviderLocator,
} from '../../sandbox-control/vercel-provider.js';
import {
  authenticateVercelForwardToken,
  expectedVercelIdentity,
  verifiedVercelSandboxIdentityContract,
} from '../../scm-broker/vercel-identity.js';
import { vercelJwksCache } from '../../scm-broker/vercel-jwks.js';
import type { AgentSandboxProvider, Env } from '../../types.js';
import {
  configuredVercelRuntimeProxyForwardUrl,
  runtimeCredentialProxyOriginSchema,
  sameRuntimeProxyOriginBinding,
  type RuntimeCredentialProxyOrigin,
  type RuntimeProxyControlBinding,
} from '../../runtime-credential-proxy-origin.js';

/**
 * The authoritative sandbox state an origin admission reads. The Sandbox DO
 * owns every field; a request can never supply any of them. `ownerId` is the
 * Sandbox DO's authoritative owner, not a caller-supplied session user.
 */
export type RuntimeProxyOriginAdmissionContext = {
  /** Authoritative owner from the Sandbox DO, or null when it has none. */
  ownerId: string | null;
  logicalSandboxId: string;
  provider: AgentSandboxProvider;
  allocation: Pick<
    AllocationState,
    'kind' | 'allocationId' | 'providerRef' | 'connectionId' | 'wrapperId'
  >;
  /** The managed outbound container id for this allocation, when it has one. */
  outboundContainerId: string | null;
  /** The provider's physical allocation name. */
  physicalName: string;
  byoc?: ByocVercelSource;
  locator: VercelProviderLocator | null;
};

export type RuntimeProxyOriginAdmissionDependencies = {
  env: Env;
  now?: () => number;
  keys?: typeof vercelJwksCache;
  fetchCredential?: (env: Env, input: ByocVercelSource) => Promise<ByocVercelCredential>;
};

export type RuntimeProxyOriginContextReader = () => Promise<RuntimeProxyOriginAdmissionContext>;

type RuntimeProxyOriginVerificationInput = {
  origin: RuntimeCredentialProxyOrigin;
  context: RuntimeProxyOriginAdmissionContext;
  env: Env;
  now?: () => number;
  keys?: typeof vercelJwksCache;
  fetchCredential?: (env: Env, input: ByocVercelSource) => Promise<ByocVercelCredential>;
};

type RuntimeProxyOriginVerification = {
  binding: RuntimeProxyControlBinding;
  /** Vercel OIDC expiry in seconds; null for fixed native evidence. */
  expiresAt: number | null;
};

/**
 * The reconnect-safe binding snapshot for an active allocation. `null` means
 * the allocation is not in a state that may carry runtime proxy traffic.
 */
export function currentRuntimeProxyControlBinding(
  context: RuntimeProxyOriginAdmissionContext
): RuntimeProxyControlBinding | null {
  const { kind, allocationId, providerRef, connectionId, wrapperId } = context.allocation;
  if (
    (kind !== 'connected' && kind !== 'disconnected') ||
    allocationId === null ||
    providerRef === null ||
    connectionId === null ||
    wrapperId === null
  ) {
    return null;
  }
  return {
    plane: 'control',
    logicalSandboxId: context.logicalSandboxId,
    allocationId,
    provider: context.provider,
    providerInstanceId: providerRef,
    connectionId,
    wrapperInstanceId: wrapperId,
  };
}

/**
 * All provider-account evidence that a Vercel origin was verified against.
 * A post-await re-read must match this exactly; SCM's providerContext uses the
 * same concatenation of physical name, BYOC source and locator.
 */
function originIdentityBinding(context: RuntimeProxyOriginAdmissionContext): string {
  return JSON.stringify([
    context.logicalSandboxId,
    context.provider,
    context.ownerId,
    context.outboundContainerId,
    context.physicalName,
    context.byoc ?? null,
    context.locator,
  ]);
}

/**
 * SCM providerContext semantics: a Vercel origin is available only when the
 * provider, BYOC source and locator exist and the BYOC source is either
 * org-owned or owned by the Sandbox DO's authoritative owner.
 */
function vercelProviderAvailable(
  context: RuntimeProxyOriginAdmissionContext
): context is RuntimeProxyOriginAdmissionContext & {
  ownerId: string;
  byoc: ByocVercelSource;
  locator: VercelProviderLocator;
} {
  return (
    context.provider === 'vercel' &&
    context.ownerId !== null &&
    context.byoc !== undefined &&
    context.locator !== null &&
    (context.byoc.userId === undefined || context.byoc.userId === context.ownerId)
  );
}

async function admitsVercelOrigin(
  origin: Extract<RuntimeCredentialProxyOrigin, { type: 'vercel' }>,
  context: RuntimeProxyOriginAdmissionContext,
  binding: RuntimeProxyControlBinding,
  deps: RuntimeProxyOriginAdmissionDependencies,
  now: () => number
): Promise<number | null> {
  if (origin.logicalSandboxId !== undefined && origin.logicalSandboxId !== context.logicalSandboxId)
    return null;
  // Owner mismatch must fail before any BYOC credential lookup.
  if (!vercelProviderAvailable(context)) return null;
  const audience = configuredVercelRuntimeProxyForwardUrl(deps.env, context.logicalSandboxId);
  const providerRef = decodeVercelProviderRef(binding.providerInstanceId);
  if (!audience || !providerRef) return null;
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
    contract: verifiedVercelSandboxIdentityContract,
  });
  if (!expected) return null;
  // Capture the clock after provider credential lookup, then re-check the
  // returned expiry after the JWKS lookup as well. A token that expires during
  // either await must not be admitted.
  const identity = await authenticateVercelForwardToken(
    origin.oidcToken,
    expected,
    deps.keys ?? vercelJwksCache,
    now()
  );
  if (!identity || identity.exp <= Math.floor(now() / 1000)) return null;
  return identity.exp;
}

async function verifyRuntimeProxyOrigin(
  input: RuntimeProxyOriginVerificationInput,
  now: () => number
): Promise<RuntimeProxyOriginVerification | null> {
  const origin = runtimeCredentialProxyOriginSchema.safeParse(input.origin);
  if (!origin.success) return null;
  const binding = currentRuntimeProxyControlBinding(input.context);
  if (binding === null) return null;
  if (origin.data.type === 'cloudflare-containers') {
    if (binding.provider !== 'cloudflare-containers') return null;
    if (
      input.context.outboundContainerId === null ||
      origin.data.containerId !== input.context.outboundContainerId ||
      origin.data.allocationRef !== binding.providerInstanceId
    ) {
      return null;
    }
    return { binding, expiresAt: null };
  }
  if (binding.provider !== 'vercel') return null;
  const expiresAt = await admitsVercelOrigin(origin.data, input.context, binding, input, now);
  return expiresAt === null ? null : { binding, expiresAt };
}

/**
 * Admits one origin against the current authoritative allocation and returns
 * the binding snapshot. A `null` result is a denial; provider-verification
 * infrastructure failures (for example an unavailable Vercel JWKS or BYOC
 * credential lookup) propagate so the facade can return a retryable 503.
 */
export async function admitRuntimeProxyOrigin(
  input: RuntimeProxyOriginVerificationInput
): Promise<RuntimeProxyControlBinding | null> {
  const verification = await verifyRuntimeProxyOrigin(input, input.now ?? Date.now);
  return verification?.binding ?? null;
}

/**
 * Re-admits the origin after a token renewal. The origin is verified in full
 * again (including Vercel owner/BYOC identity and OIDC expiry), then the
 * Sandbox DO's authoritative context is re-read AFTER those awaits. The latest
 * provider identity and allocation binding must both equal the entry snapshot
 * and the caller's expected binding, so an allocation or wrapper replacement
 * during resolution cannot inherit the credential.
 */
export async function admitExpectedRuntimeProxyOriginBinding(input: {
  origin: RuntimeCredentialProxyOrigin;
  expected: RuntimeProxyControlBinding;
  context: RuntimeProxyOriginAdmissionContext;
  /** Re-reads authoritative Sandbox DO state after provider awaits. */
  readContext: RuntimeProxyOriginContextReader;
  env: Env;
  now?: () => number;
  keys?: typeof vercelJwksCache;
  fetchCredential?: (env: Env, input: ByocVercelSource) => Promise<ByocVercelCredential>;
}): Promise<boolean> {
  const now = input.now ?? Date.now;
  const initialIdentity = originIdentityBinding(input.context);
  const verification = await verifyRuntimeProxyOrigin(input, now);
  if (verification === null || !sameRuntimeProxyOriginBinding(verification.binding, input.expected))
    return false;
  const latest = await input.readContext();
  if (originIdentityBinding(latest) !== initialIdentity) return false;
  const latestBinding = currentRuntimeProxyControlBinding(latest);
  if (latestBinding === null || !sameRuntimeProxyOriginBinding(latestBinding, input.expected))
    return false;
  return verification.expiresAt !== null ? verification.expiresAt > Math.floor(now() / 1000) : true;
}
