import {
  CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION,
  CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION,
  getSandboxAllocationProvider,
  getSandboxAllocationRequest,
  normalizeSandboxAllocation,
  type SandboxAllocation,
  type SandboxDestination,
} from '@kilocode/worker-utils/sandbox-allocation';
import { providerUsesOutboundCredentialProxy } from './agent-sandbox/capabilities.js';
import type { AgentSandboxProvider, SandboxId, Env } from './types.js';
import { CODE_REVIEW_PLATFORM } from './session-identity.js';
import { isCloudAgentContainerBillingEnabled } from './container-billing-rollout.js';
import { providerSupportsEnforcedBilling } from './sandbox-provider-eligibility.js';

export const MANAGED_SCM_OUTBOUND_HANDLER = 'managedScm';

export type SandboxRoutingOptions = {
  sandboxAllocation?: SandboxAllocation;
  createdOnPlatform?: string;
};

/**
 * Isolated sandbox-ID prefix per allocation. Every sandbox serves one workspace,
 * so every allocation a new session can use has an isolated prefix. The retired
 * `cloudflare-shared` allocation has none and cannot generate an identity.
 */
const SANDBOX_ALLOCATION_ID_PREFIX: Record<SandboxAllocation, 'istd' | 'ses' | undefined> = {
  'isolated-standard': 'istd',
  'cloudflare-single': 'ses',
  'cloudflare-shared': undefined,
  'cloudflare-containers-standard-3': 'ses',
  'cloudflare-containers-standard-4': 'ses',
  'vercel-small': 'ses',
  'vercel-large': 'ses',
};

export const RETIRED_SHARED_SANDBOX_MESSAGE =
  'Shared sandboxes are retired: every sandbox serves one workspace';

function sandboxIdMatchesAllocation(sandboxId: string, allocation: SandboxAllocation): boolean {
  const prefix = SANDBOX_ALLOCATION_ID_PREFIX[allocation];
  return prefix !== undefined && new RegExp(`^${prefix}-[0-9a-f]{48}$`).test(sandboxId);
}

export type SandboxIdClass =
  | 'placed'
  | 'shared'
  | 'legacy-shared'
  | 'isolated-small'
  | 'isolated-standard'
  | 'code-review'
  | 'devcontainer'
  | 'unknown';

/**
 * Neutral control-plane sandbox key. The prefix carries no routing meaning: a
 * placed key routes only through its stored kind (`sandbox-placement.ts`),
 * so prefix routing must reject it rather than fall through to a default pool.
 */
export function isPlacedSandboxKey(sandboxId: string): boolean {
  return /^sbx-[0-9a-f]{48}$/.test(sandboxId);
}

export function classifySandboxId(sandboxId: string): SandboxIdClass {
  if (isPlacedSandboxKey(sandboxId)) return 'placed';
  if (/^istd-[0-9a-f]+$/.test(sandboxId)) return 'isolated-standard';
  if (/^ses-[0-9a-f]+$/.test(sandboxId)) return 'isolated-small';
  if (/^crv-[0-9a-f]+$/.test(sandboxId)) return 'code-review';
  if (/^dind-[0-9a-f]+$/.test(sandboxId)) return 'devcontainer';
  // Legacy decode only: retired shared sandbox keys that stored metadata can still name.
  if (/^(org|usr|bot|ubt)-[0-9a-f]+$/.test(sandboxId)) return 'shared';
  if (sandboxId.includes('__')) return 'legacy-shared';
  return 'unknown';
}

export function isValidSandboxId(sandboxId: string): sandboxId is SandboxId {
  return classifySandboxId(sandboxId) !== 'unknown';
}

export function isIsolatedSandboxId(sandboxId: string): boolean {
  return /^(ses|istd|crv|dind)-/.test(sandboxId);
}

/**
 * Legacy decode only: a retired owner-scoped shared sandbox key. Stored session
 * metadata can still name one; nothing generates it.
 */
export function isGeneratedSharedSandboxId(sandboxId: string): sandboxId is SandboxId {
  return /^(org|usr|bot|ubt)-[0-9a-f]{48}$/.test(sandboxId);
}

/**
 * Parses a comma-separated org ID list into a set.
 * Returns an empty set when the value is falsy or blank.
 */
function parseCommaSeparatedList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export function parseOrgIdList(raw: string | undefined): Set<string> {
  return new Set(parseCommaSeparatedList(raw));
}

/**
 * Returns true when orgId is included in a comma-separated org ID list.
 * - Empty/unset list → false for everyone.
 * - '*' → true for everyone.
 * - Comma-separated list → true only when orgId is present.
 */
export function isOrgInList(raw: string | undefined, orgId: string | undefined): boolean {
  const orgs = parseOrgIdList(raw);
  if (orgs.size === 0) return false;
  if (orgs.has('*')) return true;
  return orgId !== undefined && orgs.has(orgId);
}

export function getManagedOutboundContainerId(
  provider: AgentSandboxProvider,
  env: Pick<Env, 'SANDBOX_CONTAINERS'>,
  ids: { logicalSandboxId: string; physicalSandboxId: string }
): string | undefined {
  if (!providerUsesOutboundCredentialProxy(provider)) return undefined;
  // The legacy Cloudflare Sandbox runtime has no compute authority. Failing
  // closed keeps a stale persisted provider from reaching a retired namespace.
  if (provider !== 'cloudflare-containers') {
    throw new Error('The legacy Cloudflare Sandbox runtime has been retired');
  }
  return env.SANDBOX_CONTAINERS.idFromName(ids.logicalSandboxId).toString();
}

export async function hashToSandboxId(input: string, prefix: string): Promise<SandboxId> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hashHex.substring(0, 48)}` as SandboxId;
}

export type SandboxSelection = {
  sandboxId: SandboxId;
  provider: AgentSandboxProvider;
};

export type SandboxSelectionEnv = Pick<
  Env,
  | 'CLOUD_AGENT_CONTAINER_BILLING_ENABLED'
  | 'CLOUD_AGENT_CONTAINER_BILLING_USER_IDS'
  | 'CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS'
>;

type SelectSandboxForNewSessionInput = {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  sessionId: string;
  sandboxAllocation?: SandboxAllocation;
};

/**
 * Resolves the platform provider or an explicitly selected allocation.
 * Vercel admission belongs to BYOC registration; platform defaults use Cloudflare.
 */
export function selectSandboxProvider(input: {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  sandboxId: SandboxId;
  sessionId: string;
  sandboxAllocation?: SandboxAllocation;
}): AgentSandboxProvider {
  const allocation = input.sandboxAllocation;
  if (allocation !== undefined) {
    if (!sandboxIdMatchesAllocation(input.sandboxId, allocation)) {
      throw new Error('Sandbox allocation does not match the sandbox identity');
    }
    return getSandboxAllocationProvider(allocation);
  }
  return selectDefaultSandboxProvider({
    env: input.env,
    orgId: input.orgId,
    userId: input.userId,
    isolated: input.sandboxId.startsWith('ses-'),
  });
}

export function selectDefaultSandboxProvider(input: {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  isolated: boolean;
}): AgentSandboxProvider {
  const enforced = isCloudAgentContainerBillingEnabled(input.env, {
    userId: input.userId,
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
  });
  const eligible = (provider: AgentSandboxProvider): boolean =>
    !enforced || providerSupportsEnforcedBilling(provider);

  const useContainers = eligible('cloudflare-containers') && input.isolated;

  return useContainers ? 'cloudflare-containers' : 'cloudflare';
}

/**
 * New control-plane sessions run on the native containers runtime at 2 vCPU /
 * 8 GiB. `cloudflare-single` is a compatibility alias for that same size.
 * Existing sessions are unaffected because they keep their stored provider.
 */
export function cloudflareSandboxSmallNativeReplacement(input: {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  sessionId: string;
  requestedAllocation?: SandboxAllocation;
  contained: boolean;
  createdOnPlatform?: string;
  billingOrigin?: string;
}): SandboxAllocation | undefined {
  if (
    input.billingOrigin === CODE_REVIEW_PLATFORM ||
    input.createdOnPlatform === CODE_REVIEW_PLATFORM
  ) {
    return undefined;
  }
  if (input.requestedAllocation === 'cloudflare-single') {
    return CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION;
  }
  if (!input.contained) return undefined;
  if (input.requestedAllocation !== undefined) return undefined;
  const provider = selectDefaultSandboxProvider({
    env: input.env,
    orgId: input.orgId,
    userId: input.userId,
    isolated: true,
  });
  return provider === 'cloudflare-containers'
    ? CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION
    : undefined;
}

export function resolveNewSessionSandboxAllocation(input: {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  sessionId: string;
  requestedAllocation?: SandboxAllocation;
  contained: boolean;
  createdOnPlatform?: string;
  billingOrigin?: string;
}): SandboxAllocation | undefined {
  return cloudflareSandboxSmallNativeReplacement(input) ?? input.requestedAllocation;
}

/**
 * Ledger retries accept the request, the native replacement recorded for it, or
 * either end of the `cloudflare-single` alias. A recorded allocation therefore
 * keeps matching without rewriting the persisted runtime.
 */
export function recordedSandboxAllocationMatchesRequest(
  recorded: SandboxAllocation | undefined,
  requested: SandboxAllocation | undefined,
  replacement: SandboxAllocation | undefined
): boolean {
  const recordedAllocation = recorded && normalizeSandboxAllocation(recorded);
  if (requested === undefined) {
    // A retry that omits the choice accepts the native default it would resolve
    // today, plus the historical alias recorded for that same runtime.
    return (
      recordedAllocation === undefined ||
      recordedAllocation === CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION
    );
  }
  const requestedAllocation = normalizeSandboxAllocation(requested);
  return (
    recordedAllocation === requestedAllocation ||
    (replacement !== undefined && recordedAllocation === normalizeSandboxAllocation(replacement))
  );
}

export function getDefaultSandboxDestination(
  env: SandboxSelectionEnv,
  owner: { userId: string; orgId?: string }
): SandboxDestination {
  const provider = selectDefaultSandboxProvider({
    env,
    orgId: owner.orgId,
    userId: owner.userId,
    isolated: true,
  });
  if (provider === 'cloudflare-containers') {
    return getSandboxAllocationRequest(CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION);
  }
  return getSandboxAllocationRequest(CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION);
}

export async function selectSandboxForNewSession(
  input: SelectSandboxForNewSessionInput
): Promise<SandboxSelection> {
  const sandboxAllocation = resolveNewSessionSandboxAllocation({
    env: input.env,
    orgId: input.orgId,
    userId: input.userId,
    sessionId: input.sessionId,
    requestedAllocation: input.sandboxAllocation,
    contained: true,
  });
  const sandboxId = await generateSandboxId(input.sessionId, { sandboxAllocation });
  const provider = selectSandboxProvider({
    env: input.env,
    orgId: input.orgId,
    userId: input.userId,
    sandboxId,
    sessionId: input.sessionId,
    sandboxAllocation,
  });

  return { sandboxId, provider };
}

/**
 * Generate a deterministic, Cloudflare-compatible isolated sandboxId (≤63 chars).
 *
 * One sandbox serves one workspace. Sessions get an isolated `ses-` identity,
 * an explicit allocation keeps its isolated prefix, and trusted Code Reviewer
 * sessions keep their dedicated `crv-` namespace.
 */
export async function generateSandboxId(
  sessionId: string,
  options: SandboxRoutingOptions = {}
): Promise<SandboxId> {
  const allocation = options.sandboxAllocation;
  if (allocation !== undefined) {
    if (options.createdOnPlatform === 'code-review') {
      throw new Error('Sandbox allocations cannot be combined with specialized sandbox routing');
    }
    const prefix = SANDBOX_ALLOCATION_ID_PREFIX[allocation];
    if (prefix === undefined) throw new Error(RETIRED_SHARED_SANDBOX_MESSAGE);
    return hashToSandboxId(sessionId, prefix);
  }
  return hashToSandboxId(sessionId, options.createdOnPlatform === 'code-review' ? 'crv' : 'ses');
}
