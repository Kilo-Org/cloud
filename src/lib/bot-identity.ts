import 'server-only';
import crypto from 'node:crypto';
import type { StateAdapter } from 'chat';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

/**
 * Platform identity coordinates — the minimum info needed to identify
 * a user on any chat platform (Slack, Discord, Teams, Google Chat, etc.).
 */
export type PlatformIdentity = {
  /** e.g. "slack", "discord", "teams", "gchat" */
  platform: string;
  /** Workspace / team / guild / tenant ID */
  teamId: string;
  /** Platform-specific user ID (e.g. Slack's "U123ABC") */
  userId: string;
};

// -- Redis key helpers --------------------------------------------------------

function redisKey({ platform, teamId, userId }: PlatformIdentity): string {
  return `identity:${platform}:${teamId}:${userId}`;
}

/**
 * Look up the Kilo user ID linked to a chat-platform user.
 * Returns `null` when no mapping exists yet.
 */
export async function resolveKiloUserId(
  state: StateAdapter,
  identity: PlatformIdentity
): Promise<string | null> {
  return state.get<string>(redisKey(identity));
}

/**
 * Persist a platform-user → Kilo-user link.
 */
export async function linkKiloUser(
  state: StateAdapter,
  identity: PlatformIdentity,
  kiloUserId: string
): Promise<void> {
  await state.set(redisKey(identity), kiloUserId);
}

/**
 * Remove a previously stored link.
 */
export async function unlinkKiloUser(
  state: StateAdapter,
  identity: PlatformIdentity
): Promise<void> {
  await state.delete(redisKey(identity));
}

// -- HMAC-signed link tokens --------------------------------------------------
//
// The link-account URL carries a single `token` query parameter rather than
// plain-text platform/teamId/userId.  The token is HMAC-signed and time-limited
// so a third party cannot forge a link for a team they don't belong to.
//
// Format:  base64url({ platform, teamId, userId, iat, nonce }) . HMAC-SHA256
//
// Follows the same pattern as src/lib/integrations/oauth-state.ts.

const HMAC_ALGORITHM = 'sha256';

const TOKEN_TTL_SECONDS = 30 * 60;

const NONCE_BYTES = 16;

function hmacSign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

/** Create a signed, time-limited token encoding a PlatformIdentity. */
export function createLinkToken(identity: PlatformIdentity): string {
  const iat = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...identity, iat, nonce })).toString('base64url');
  return `${payload}.${hmacSign(payload)}`;
}

/** Verify and decode a link token. Returns the identity or `null` on failure. */
export function verifyLinkToken(token: string): PlatformIdentity | null {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  const expectedSig = hmacSign(payload);
  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      platform?: string;
      teamId?: string;
      userId?: string;
      iat?: number;
      nonce?: string;
    };

    if (
      typeof data.platform !== 'string' ||
      typeof data.teamId !== 'string' ||
      typeof data.userId !== 'string'
    ) {
      return null;
    }

    if (typeof data.iat !== 'number') return null;
    const age = Math.floor(Date.now() / 1000) - data.iat;
    if (age < 0 || age > TOKEN_TTL_SECONDS) return null;

    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    return { platform: data.platform, teamId: data.teamId, userId: data.userId };
  } catch {
    return null;
  }
}
