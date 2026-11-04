import type { SessionId } from './types.js';

export const CONTROL_PLANE_SESSION_PREFIX = 'workspace_';

export function isControlSession(sessionId: string): sessionId is SessionId {
  return sessionId.startsWith(CONTROL_PLANE_SESSION_PREFIX);
}

export function generateSessionId(): SessionId {
  return `${CONTROL_PLANE_SESSION_PREFIX}${crypto.randomUUID()}`;
}

/** `billingOrigin` value that identifies a Code Reviewer session. */
export const CODE_REVIEW_PLATFORM = 'code-review';

/**
 * The one place a Session DO is named (spec §3): `ownerId:sessionId`. The Worker
 * stub and both V2 DOs must address the same instance through this function.
 */
export function sessionDoName(ownerId: string, sessionId: string): string {
  return `${ownerId}:${sessionId}`;
}

/**
 * Recover the bare `sessionId` from a Session DO name. Split on the *last*
 * colon because `ownerId` may itself contain colons (for example
 * `oauth/google:12345:workspace_abc`).
 */
export function sessionIdFromDoName(name: string): string {
  const lastColon = name.lastIndexOf(':');
  return lastColon >= 0 ? name.slice(lastColon + 1) : name;
}

export type SessionCreateOrigin = {
  createdOnPlatform?: string;
  /**
   * Worker-owned effective origin. Unlike the client-supplied
   * `createdOnPlatform`, this cannot be forged by a public create endpoint, so
   * specialized routing decisions read it here.
   */
  billingOrigin?: string;
};

/**
 * Provider tool capability a session needs from its sandbox image, from the two
 * independent trusted origin signals. The code-review publisher is identified by
 * the trusted `billingOrigin`; security remediation by the runtime
 * `createdOnPlatform`. A public `start` stamps `billingOrigin: 'cloud-agent'`,
 * which must not mask a remediation runtime origin, so the two checks stay
 * separate.
 */
export function requiredProviderCapability(
  origin?: SessionCreateOrigin
): 'review' | 'remediation' | undefined {
  if (origin?.createdOnPlatform === 'security-remediation') return 'remediation';
  if (
    origin?.billingOrigin === CODE_REVIEW_PLATFORM ||
    origin?.createdOnPlatform === CODE_REVIEW_PLATFORM
  ) {
    return 'review';
  }
  return undefined;
}

export type CodeReviewContainersEnv = {
  CODE_REVIEW_CONTAINERS_ORG_IDS?: string;
};

/** Provider enrollment for Code Reviewer sessions. */
export function isCodeReviewContainersOwner(
  env: CodeReviewContainersEnv,
  owner: { userId: string; orgId?: string }
): boolean {
  return (
    ownerIdInList(env.CODE_REVIEW_CONTAINERS_ORG_IDS, owner.userId) ||
    ownerIdInList(env.CODE_REVIEW_CONTAINERS_ORG_IDS, owner.orgId)
  );
}

/** UI gate only: hides the preview button and links; entry still checks session access. */
export function isPreviewOwner(
  env: { PREVIEW_ENABLED_IDS?: string },
  owner: { userId: string; orgId?: string }
): boolean {
  return (
    ownerIdInList(env.PREVIEW_ENABLED_IDS, owner.userId) ||
    ownerIdInList(env.PREVIEW_ENABLED_IDS, owner.orgId)
  );
}

function ownerIdInList(raw: string | undefined, id: string | undefined): boolean {
  if (!raw) return false;
  const items = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (items.includes('*')) return true;
  return id !== undefined && items.includes(id);
}
