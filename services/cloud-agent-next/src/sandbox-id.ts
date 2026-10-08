import {
  CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION,
  getSandboxAllocationProvider,
  getSandboxAllocationRequest,
  sandboxAllocationRequiresControlPlane,
  type SandboxAllocation,
  type SandboxDestination,
} from '@kilocode/worker-utils/sandbox-allocation';
import { providerUsesOutboundCredentialProxy } from './agent-sandbox/capabilities.js';
import type { AgentSandboxProvider, SandboxId, Env } from './types.js';
import {
  sessionPlaneForNewOwner,
  sessionPlaneFromId,
  type ControlPlaneOwnerEnv,
  type SessionPlane,
} from './session-plane.js';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  parseVercelSandboxEnrollment,
  parseVercelSandboxRuntimeConfig,
  type VercelSandboxEnrollmentEnv,
  type VercelSandboxRuntimeConfigEnv,
} from './agent-sandbox/vercel/vercel-runtime-config.js';
import {
  isCloudflareContainersEnrolled,
  type CloudflareContainersEnrollmentEnv,
} from './agent-sandbox/cloudflare-containers/cloudflare-containers-runtime-config.js';
import { isCloudAgentContainerBillingEnabled } from './container-billing-rollout.js';
import { providerSupportsEnforcedBilling } from './sandbox-provider-eligibility.js';

export const MANAGED_SCM_OUTBOUND_HANDLER = 'managedScm';

const SHARED_SANDBOX_ID_VERSION = 'shared-v3';
const CONTROL_PLANE_SHARED_SANDBOX_ID_VERSION = 'shared-control-v1';

type SharedSandboxPrefix = 'org' | 'usr' | 'bot' | 'ubt';
type SandboxNamespaceEnv = Pick<
  Env,
  | 'Sandbox'
  | 'SandboxContainment'
  | 'SandboxSmallContainment'
  | 'SandboxDIND'
  | 'SandboxCodeReviewContainment'
>;

type SandboxNamespaceOptions = {
  managedScmContainment?: boolean;
};

export type SharedSandboxRoutingTarget = {
  kind: 'shared';
  routeKey: SandboxId;
};

export type SandboxRoutingTarget =
  | SharedSandboxRoutingTarget
  | {
      kind: 'isolated';
      sandboxId: SandboxId;
    };

export type SandboxRoutingOptions = {
  sandboxAllocation?: SandboxAllocation;
  createdOnPlatform?: string;
  /**
   * Marks a fallback for a session that predates `workspace.sandboxId` storage.
   * Such a session must regenerate the identity it originally used, which
   * predates the isolated-by-default routing, so honor the per-session org
   * allowlist and otherwise fall back to the owner-scoped shared identity.
   */
  legacyFallback?: boolean;
};

/**
 * Isolated sandbox-ID prefix per allocation. `cloudflare-shared` maps to no prefix
 * because it routes to the shared sandbox rather than an isolated identity.
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

function sandboxIdMatchesAllocation(sandboxId: string, allocation: SandboxAllocation): boolean {
  const prefix = SANDBOX_ALLOCATION_ID_PREFIX[allocation];
  return prefix === undefined
    ? isGeneratedSharedSandboxId(sandboxId)
    : new RegExp(`^${prefix}-[0-9a-f]{48}$`).test(sandboxId);
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

export function isGeneratedSharedSandboxId(sandboxId: string): sandboxId is SandboxId {
  return /^(org|usr|bot|ubt)-[0-9a-f]{48}$/.test(sandboxId);
}

function getSharedSandboxPrefix(sandboxId: SandboxId): SharedSandboxPrefix {
  if (sandboxId.startsWith('org-')) return 'org';
  if (sandboxId.startsWith('usr-')) return 'usr';
  if (sandboxId.startsWith('bot-')) return 'bot';
  if (sandboxId.startsWith('ubt-')) return 'ubt';
  throw new Error('Cannot derive a shared sandbox ID from an isolated sandbox');
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

export function getSandboxNamespace(
  env: SandboxNamespaceEnv,
  sandboxId: string,
  options: SandboxNamespaceOptions = {}
): DurableObjectNamespace<Sandbox> {
  if (isPlacedSandboxKey(sandboxId)) {
    throw new Error('A placed sandbox key routes only through its stored kind');
  }
  // Persisted DIND sessions retain their namespace until operator-verified retirement.
  if (sandboxId.startsWith('dind-')) return env.SandboxDIND;
  // Every non-contained sandbox runs in the standard pool; SandboxSmall and
  // SandboxCodeReview are retired and receive no traffic.
  if (options.managedScmContainment !== true) return env.Sandbox;
  if (sandboxId.startsWith('crv-')) return env.SandboxCodeReviewContainment;
  if (sandboxId.startsWith('ses-')) return env.SandboxSmallContainment;
  return env.SandboxContainment;
}

export function getManagedOutboundContainerId(
  provider: AgentSandboxProvider,
  env: SandboxNamespaceEnv & Pick<Env, 'SANDBOX_CONTAINERS'>,
  ids: { logicalSandboxId: string; physicalSandboxId: string }
): string | undefined {
  if (!providerUsesOutboundCredentialProxy(provider)) return undefined;
  if (provider === 'cloudflare-containers') {
    return env.SANDBOX_CONTAINERS.idFromName(ids.logicalSandboxId).toString();
  }
  return getOutboundContainerId(env, ids.physicalSandboxId, { managedScmContainment: true });
}

export function getOutboundContainerId(
  env: SandboxNamespaceEnv,
  sandboxId: string,
  options: SandboxNamespaceOptions = {}
): string {
  return getSandboxNamespace(env, sandboxId, options).idFromName(sandboxId).toString();
}

export async function hashToSandboxId(input: string, prefix: string): Promise<SandboxId> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hashHex.substring(0, 48)}` as SandboxId;
}

export function deriveRetiredDindSandboxId(sessionId: string): Promise<SandboxId> {
  return hashToSandboxId(sessionId, 'dind');
}

export async function deriveSharedSandboxId(
  routeKey: SandboxId,
  suffix: string
): Promise<SandboxId> {
  if (!isGeneratedSharedSandboxId(routeKey)) {
    throw new Error('Shared sandbox route key must be a generated shared sandbox ID');
  }
  return hashToSandboxId(`${suffix}:${routeKey}`, getSharedSandboxPrefix(routeKey));
}

export type SandboxSelection = {
  sandboxId: SandboxId;
  provider: AgentSandboxProvider;
};

export type SandboxSelectionEnv = {
  PER_SESSION_SANDBOX_ORG_IDS?: string;
} & VercelSandboxEnrollmentEnv &
  VercelSandboxRuntimeConfigEnv &
  CloudflareContainersEnrollmentEnv &
  Pick<
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
  botId?: string;
  sandboxAllocation?: SandboxAllocation;
};

/**
 * Resolves the sandbox provider for an already-computed sandbox ID. Vercel
 * is call-home only: isolated `workspace_` sessions whose owner is on
 * `VERCEL_SANDBOX_ORG_IDS` (`*` includes personal) with complete operational
 * configuration. Legacy `agent_` sessions and everything else stay on Cloudflare.
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
    if (
      sandboxAllocationRequiresControlPlane(allocation) &&
      sessionPlaneFromId(input.sessionId) !== 'control'
    ) {
      throw new Error('Sandbox allocations for this provider require a control-plane session');
    }
    if (!sandboxIdMatchesAllocation(input.sandboxId, allocation)) {
      throw new Error('Sandbox allocation does not match the sandbox identity');
    }
    return getSandboxAllocationProvider(allocation);
  }
  return selectDefaultSandboxProvider({
    env: input.env,
    orgId: input.orgId,
    userId: input.userId,
    plane: sessionPlaneFromId(input.sessionId),
    isolated: input.sandboxId.startsWith('ses-'),
  });
}

export function selectDefaultSandboxProvider(input: {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  plane: SessionPlane;
  isolated: boolean;
}): AgentSandboxProvider {
  const enforced = isCloudAgentContainerBillingEnabled(input.env, {
    userId: input.userId,
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
  });
  const eligible = (provider: AgentSandboxProvider): boolean =>
    !enforced || providerSupportsEnforcedBilling(provider);

  const enrollment = parseVercelSandboxEnrollment(input.env);
  const runtimeConfig = parseVercelSandboxRuntimeConfig(input.env);
  const enrolled =
    input.orgId !== undefined
      ? enrollment.orgIds.has('*') || enrollment.orgIds.has(input.orgId)
      : enrollment.allowPersonal;
  const useVercel =
    eligible('vercel') &&
    input.plane === 'control' &&
    input.isolated &&
    enrollment.enabled &&
    enrolled &&
    runtimeConfig !== undefined;

  if (useVercel) return 'vercel';

  const useContainers =
    eligible('cloudflare-containers') &&
    input.plane === 'control' &&
    input.isolated &&
    isCloudflareContainersEnrolled(input.env, { orgId: input.orgId });

  return useContainers ? 'cloudflare-containers' : 'cloudflare';
}

export function getDefaultSandboxDestination(
  env: SandboxSelectionEnv & ControlPlaneOwnerEnv,
  owner: { userId: string; orgId?: string }
): SandboxDestination {
  const provider = selectDefaultSandboxProvider({
    env,
    orgId: owner.orgId,
    userId: owner.userId,
    plane: sessionPlaneForNewOwner(env, owner, { createdOnPlatform: 'cloud-agent-web' }),
    isolated: true,
  });
  if (provider === 'vercel') {
    return { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' };
  }
  if (provider === 'cloudflare-containers') {
    return getSandboxAllocationRequest(CLOUDFLARE_CONTAINERS_DEFAULT_ALLOCATION);
  }
  return getSandboxAllocationRequest('cloudflare-single');
}

export async function selectSandboxForNewSession(
  input: SelectSandboxForNewSessionInput
): Promise<SandboxSelection> {
  const sandboxId = await generateSandboxId(
    input.env.PER_SESSION_SANDBOX_ORG_IDS,
    input.orgId,
    input.userId,
    input.sessionId,
    input.botId,
    { sandboxAllocation: input.sandboxAllocation }
  );
  const provider = selectSandboxProvider({
    env: input.env,
    orgId: input.orgId,
    userId: input.userId,
    sandboxId,
    sessionId: input.sessionId,
    sandboxAllocation: input.sandboxAllocation,
  });

  return { sandboxId, provider };
}

/**
 * Generate a deterministic, Cloudflare-compatible sandboxId (≤63 chars).
 *
 * Normal sessions default to isolated `ses-` identities. Explicit shared
 * allocations retain per-owner routing; trusted Code Reviewer sessions retain
 * their dedicated namespace.
 */
export async function generateSandboxRoutingTarget(
  perSessionOrgIds: string | undefined,
  orgId: string | undefined,
  userId: string,
  sessionId: string,
  botId?: string,
  options?: SandboxRoutingOptions
): Promise<SandboxRoutingTarget> {
  const routingOptions = options ?? {};
  const allocation = routingOptions.sandboxAllocation;
  if (allocation !== undefined) {
    if (routingOptions.createdOnPlatform === 'code-review') {
      throw new Error('Sandbox allocations cannot be combined with specialized sandbox routing');
    }
    if (
      sandboxAllocationRequiresControlPlane(allocation) &&
      sessionPlaneFromId(sessionId) !== 'control'
    ) {
      throw new Error('Sandbox allocations for this provider require a control-plane session');
    }
    const prefix = SANDBOX_ALLOCATION_ID_PREFIX[allocation];
    // `cloudflare-shared` has no isolated prefix: it falls through to the shared route.
    if (prefix) return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, prefix) };
  }
  if (routingOptions.createdOnPlatform === 'code-review') {
    return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, 'crv') };
  }
  if (allocation !== 'cloudflare-shared') {
    const preserveLegacySharedRouting =
      routingOptions.legacyFallback === true && !isOrgInList(perSessionOrgIds, orgId);
    if (!preserveLegacySharedRouting) {
      return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, 'ses') };
    }
  }

  const originalFormat = sharedSandboxOwnerKey(orgId, userId, botId);
  const prefix: SharedSandboxPrefix = botId ? (orgId ? 'bot' : 'ubt') : orgId ? 'org' : 'usr';
  const sharedVersion =
    sessionPlaneFromId(sessionId) === 'control'
      ? CONTROL_PLANE_SHARED_SANDBOX_ID_VERSION
      : SHARED_SANDBOX_ID_VERSION;
  const routeKey = await hashToSandboxId(`${sharedVersion}:${originalFormat}`, prefix);

  return {
    kind: 'shared',
    routeKey,
  };
}

/** The owner identity a shared sandbox is keyed on: org (or personal user), user and bot. */
export function sharedSandboxOwnerKey(
  orgId: string | undefined,
  userId: string,
  botId: string | undefined
): string {
  const sandboxOrgSegment = orgId ?? `user:${userId}`;
  return botId
    ? `${sandboxOrgSegment}__${userId}__bot:${botId}`
    : `${sandboxOrgSegment}__${userId}`;
}

export async function generateSandboxId(
  perSessionOrgIds: string | undefined,
  orgId: string | undefined,
  userId: string,
  sessionId: string,
  botId?: string,
  options?: SandboxRoutingOptions
): Promise<SandboxId> {
  const target = await generateSandboxRoutingTarget(
    perSessionOrgIds,
    orgId,
    userId,
    sessionId,
    botId,
    options
  );
  return target.kind === 'shared' ? target.routeKey : target.sandboxId;
}
