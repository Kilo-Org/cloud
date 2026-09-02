import type { AgentSandboxProvider, SandboxId, Env } from './types.js';
import { sessionPlaneFromId } from './session-plane.js';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  parseVercelSandboxEnrollment,
  parseVercelSandboxRuntimeConfig,
  type VercelSandboxEnrollmentEnv,
  type VercelSandboxRuntimeConfigEnv,
} from './agent-sandbox/vercel/vercel-runtime-config.js';

export const MANAGED_SCM_OUTBOUND_HANDLER = 'managedScm';

const SHARED_SANDBOX_ID_VERSION = 'shared-v3';
const CONTROL_PLANE_SHARED_SANDBOX_ID_VERSION = 'shared-control-v1';

type SharedSandboxPrefix = 'org' | 'usr' | 'bot' | 'ubt';
type SandboxNamespaceEnv = Pick<
  Env,
  | 'Sandbox'
  | 'SandboxContainment'
  | 'SandboxSmall'
  | 'SandboxSmallContainment'
  | 'SandboxDIND'
  | 'SandboxCodeReview'
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
  devcontainer?: boolean;
  createdOnPlatform?: string;
  sandboxAllocation?: 'isolated-standard';
};

export type SandboxIdClass =
  | 'shared'
  | 'legacy-shared'
  | 'isolated-small'
  | 'isolated-standard'
  | 'code-review'
  | 'devcontainer'
  | 'unknown';

export function classifySandboxId(sandboxId: string): SandboxIdClass {
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

/**
 * Returns the correct DurableObjectNamespace for the given sandbox ID.
 * - Docker-in-Docker sandboxes (dind-* prefix) use SandboxDIND
 * - Code Reviewer ephemeral sandboxes (crv-* prefix) use SandboxCodeReview
 * - Per-session Small sandboxes (ses-* prefix) use SandboxSmall
 * - Per-session Standard sandboxes (istd-* prefix) use Sandbox
 * - Shared and legacy shared sandboxes use Sandbox
 */
export function getSandboxNamespace(
  env: SandboxNamespaceEnv,
  sandboxId: string,
  options: SandboxNamespaceOptions = {}
): DurableObjectNamespace<Sandbox> {
  if (sandboxId.startsWith('dind-')) return env.SandboxDIND;
  if (sandboxId.startsWith('crv-')) {
    return options.managedScmContainment === true
      ? env.SandboxCodeReviewContainment
      : env.SandboxCodeReview;
  }
  if (sandboxId.startsWith('ses-')) {
    return options.managedScmContainment === true ? env.SandboxSmallContainment : env.SandboxSmall;
  }
  if (sandboxId.startsWith('istd-')) {
    return options.managedScmContainment === true ? env.SandboxContainment : env.Sandbox;
  }
  return options.managedScmContainment === true ? env.SandboxContainment : env.Sandbox;
}

export function getOutboundContainerId(
  env: SandboxNamespaceEnv,
  sandboxId: string,
  options: SandboxNamespaceOptions = {}
): string {
  return getSandboxNamespace(env, sandboxId, options).idFromName(sandboxId).toString();
}

async function hashToSandboxId(input: string, prefix: string): Promise<SandboxId> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hashHex.substring(0, 48)}` as SandboxId;
}

export async function deriveSandboxAllocationId(
  sandboxId: string,
  intentId: string
): Promise<SandboxId> {
  const classification = classifySandboxId(sandboxId);
  if (classification === 'unknown' || classification === 'legacy-shared' || !intentId) {
    throw new Error('Sandbox allocation requires a generated sandbox ID and create intent');
  }
  const prefix = sandboxId.slice(0, sandboxId.indexOf('-'));
  return hashToSandboxId(`control-allocation-v1:${sandboxId}:${intentId}`, prefix);
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
  VercelSandboxRuntimeConfigEnv;

type SelectSandboxForNewSessionInput = {
  env: SandboxSelectionEnv;
  orgId?: string;
  userId: string;
  sessionId: string;
  botId?: string;
  devcontainer?: boolean;
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
  sandboxId: SandboxId;
  sessionId: string;
  devcontainer?: boolean;
}): AgentSandboxProvider {
  const enrollment = parseVercelSandboxEnrollment(input.env);
  const runtimeConfig = parseVercelSandboxRuntimeConfig(input.env);
  const enrolled =
    input.orgId !== undefined
      ? enrollment.orgIds.has('*') || enrollment.orgIds.has(input.orgId)
      : enrollment.allowPersonal;
  const useVercel =
    sessionPlaneFromId(input.sessionId) === 'control' &&
    !input.devcontainer &&
    input.sandboxId.startsWith('ses-') &&
    enrollment.enabled &&
    enrolled &&
    runtimeConfig !== undefined;

  return useVercel ? 'vercel' : 'cloudflare';
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
    input.devcontainer
  );
  const provider = selectSandboxProvider({
    env: input.env,
    orgId: input.orgId,
    sandboxId,
    sessionId: input.sessionId,
    devcontainer: input.devcontainer,
  });

  return { sandboxId, provider };
}

/**
 * Generate a deterministic, Cloudflare-compatible sandboxId (≤63 chars).
 *
 * Code Reviewer sessions (createdOnPlatform === 'code-review') always get an
 * ephemeral, isolated sandbox (crv-{hash}, using SandboxCodeReview). Otherwise,
 * when the org is in PER_SESSION_SANDBOX_ORG_IDS the sandbox is isolated
 * per session (ses-{hash}, using SandboxSmall) or when devcontainer mode
 * is requested (dind-{hash}, using SandboxDIND). Otherwise it is shared
 * per org/user/bot (org-|usr-|bot-|ubt-{hash}, using Sandbox).
 *
 * @param perSessionOrgIds - Comma-separated org IDs that get per-session sandboxes (env var value)
 * @param orgId    - Organization ID (undefined for personal accounts)
 * @param userId   - User ID (required)
 * @param sessionId - Cloud-agent session ID (used for per-session sandboxes)
 * @param botId    - Bot ID (optional)
 * @returns Deterministic sandboxId string (52 characters)
 */
export async function generateSandboxRoutingTarget(
  perSessionOrgIds: string | undefined,
  orgId: string | undefined,
  userId: string,
  sessionId: string,
  botId?: string,
  options?: boolean | SandboxRoutingOptions
): Promise<SandboxRoutingTarget> {
  const routingOptions = typeof options === 'boolean' ? { devcontainer: options } : (options ?? {});
  const perSessionOrgs = parseOrgIdList(perSessionOrgIds);
  if (routingOptions.devcontainer) {
    return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, 'dind') };
  }
  if (routingOptions.createdOnPlatform === 'code-review') {
    return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, 'crv') };
  }
  if (routingOptions.sandboxAllocation === 'isolated-standard') {
    return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, 'istd') };
  }
  if (perSessionOrgs.has('*') || (orgId !== undefined && perSessionOrgs.has(orgId))) {
    return { kind: 'isolated', sandboxId: await hashToSandboxId(sessionId, 'ses') };
  }

  const sandboxOrgSegment = orgId ?? `user:${userId}`;
  const originalFormat = botId
    ? `${sandboxOrgSegment}__${userId}__bot:${botId}`
    : `${sandboxOrgSegment}__${userId}`;
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

export async function generateSandboxId(
  perSessionOrgIds: string | undefined,
  orgId: string | undefined,
  userId: string,
  sessionId: string,
  botId?: string,
  options?: boolean | SandboxRoutingOptions
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
