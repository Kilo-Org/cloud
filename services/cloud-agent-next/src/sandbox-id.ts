import type { SandboxId, Env } from './types.js';
import type { Sandbox } from '@cloudflare/sandbox';

export const MANAGED_SCM_OUTBOUND_HANDLER = 'managedScm';

type SandboxNamespaceEnv = Pick<Env, 'Sandbox' | 'SandboxSmall' | 'SandboxDIND'>;

type ManagedScmRepository =
  | { type: 'github'; repo: string }
  | { type: 'gitlab'; url: string }
  | { type: 'git'; url: string };

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

function parseOrgIdList(raw: string | undefined): Set<string> {
  return new Set(parseCommaSeparatedList(raw));
}

export function isManagedScmContainmentCanary(
  rawAllowlist: string | undefined,
  repository: ManagedScmRepository | undefined
): boolean {
  if (!repository) return false;
  const allowlist = parseCommaSeparatedList(rawAllowlist);
  if (repository.type === 'github' && 'repo' in repository) {
    const normalizedRepo = repository.repo.toLowerCase();
    return allowlist.some(entry => entry.toLowerCase() === normalizedRepo);
  }
  if (repository.type === 'gitlab' && 'url' in repository) {
    return allowlist.includes(repository.url);
  }
  return false;
}

/**
 * Returns the correct DurableObjectNamespace for the given sandbox ID.
 * - Docker-in-Docker sandboxes (dind-* prefix) use SandboxDIND
 * - Per-session sandboxes (ses-* prefix) use SandboxSmall
 * - All others use Sandbox
 */
export function getSandboxNamespace(
  env: SandboxNamespaceEnv,
  sandboxId: string
): DurableObjectNamespace<Sandbox> {
  if (sandboxId.startsWith('dind-')) return env.SandboxDIND;
  return sandboxId.startsWith('ses-') ? env.SandboxSmall : env.Sandbox;
}

export function getOutboundContainerId(env: SandboxNamespaceEnv, sandboxId: string): string {
  return getSandboxNamespace(env, sandboxId).idFromName(sandboxId).toString();
}

async function hashToSandboxId(input: string, prefix: string): Promise<SandboxId> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hashHex.substring(0, 48)}` as SandboxId;
}

/**
 * Generate a deterministic, Cloudflare-compatible sandboxId (≤63 chars).
 *
 * When the org is in PER_SESSION_SANDBOX_ORG_IDS the sandbox is isolated
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
export async function generateSandboxId(
  perSessionOrgIds: string | undefined,
  orgId: string | undefined,
  userId: string,
  sessionId: string,
  botId?: string,
  devcontainer?: boolean,
  forcePerSession = false
): Promise<SandboxId> {
  const perSessionOrgs = parseOrgIdList(perSessionOrgIds);
  if (devcontainer) {
    return hashToSandboxId(sessionId, 'dind');
  }
  if (
    forcePerSession ||
    perSessionOrgs.has('*') ||
    (orgId !== undefined && perSessionOrgs.has(orgId))
  ) {
    return hashToSandboxId(sessionId, 'ses');
  }

  // Shared sandbox: derive from org/user/bot
  const sandboxOrgSegment = orgId ?? `user:${userId}`;
  const originalFormat = botId
    ? `${sandboxOrgSegment}__${userId}__bot:${botId}`
    : `${sandboxOrgSegment}__${userId}`;

  let prefix: string;
  if (botId) {
    prefix = orgId ? 'bot' : 'ubt';
  } else {
    prefix = orgId ? 'org' : 'usr';
  }

  return hashToSandboxId(originalFormat, prefix);
}
