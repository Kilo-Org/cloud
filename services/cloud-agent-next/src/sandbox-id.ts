import type { SandboxId, Env } from './types.js';
import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Parses a comma-separated org ID list into a set.
 * Returns an empty set when the value is falsy or blank.
 */
function parseOrgIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

/**
 * Returns the correct DurableObjectNamespace for the given sandbox ID.
 * Per-session sandboxes (ses-* prefix) use SandboxSmall; all others use Sandbox.
 */
export function getSandboxNamespace(env: Env, sandboxId: string): DurableObjectNamespace<Sandbox> {
  return sandboxId.startsWith('ses-') ? env.SandboxSmall : env.Sandbox;
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
 * per session (ses-{hash}, using SandboxSmall). Otherwise it is shared
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
  botId?: string
): Promise<SandboxId> {
  const perSessionOrgs = parseOrgIdList(perSessionOrgIds);
  if (perSessionOrgs.has('*') || (orgId !== undefined && perSessionOrgs.has(orgId))) {
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
