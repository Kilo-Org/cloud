import 'server-only';
import { db } from '@/lib/drizzle';
import { device_auth_requests, kilocode_users } from '@kilocode/db/schema';
import { eq, and, lt, gt, isNull, isNotNull, sql } from 'drizzle-orm';
import { generateApiToken } from '@/lib/tokens';
import { randomInt, createHash, randomBytes } from 'node:crypto';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';

const CODE_LENGTH = 8;
const CODE_EXPIRATION_MINUTES = 10;
const MAX_PENDING_REQUESTS_PER_IP = 5;

/**
 * Generate a random human-readable device authorization code.
 * Uses only unambiguous characters for better UX.
 */
export function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += chars.charAt(randomInt(chars.length));
  }
  // Format as XXXX-XXXX (8 characters total)
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** @deprecated — ponytail: remove after all shipped clients migrate to userCode/deviceCode split */
export const generateDeviceCode = generateUserCode;

/**
 * Generate a high-entropy device secret for polling.
 * 256-bit random value encoded as base64url.
 */
export function generateDeviceSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a device secret with SHA-256.
 * The secret is already high-entropy, so a plain digest is sufficient.
 */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Create a new device authorization request.
 * Writes both the legacy code and new user_code/device_code_hash.
 */
export async function createDeviceAuthRequest(params: {
  userAgent?: string;
  ipAddress?: string;
}): Promise<{ code: string; userCode: string; deviceCode: string; expiresAt: Date }> {
  const { userAgent, ipAddress } = params;

  // Validate IP address on Production
  if (process.env['NODE_ENV'] === 'production' && !ipAddress) {
    throw new Error('IP address is required in production');
  }

  // Rate limiting: check pending requests from this IP
  if (ipAddress) {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(device_auth_requests)
      .where(
        and(
          eq(device_auth_requests.ip_address, ipAddress),
          eq(device_auth_requests.status, 'pending')
        )
      );

    if (result && result.count >= MAX_PENDING_REQUESTS_PER_IP) {
      throw new Error('Too many pending authorization requests from this IP');
    }
  }

  const userCode = generateUserCode();
  const deviceSecret = generateDeviceSecret();
  const deviceCodeHash = hashDeviceSecret(deviceSecret);
  const expiresAt = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

  await db.insert(device_auth_requests).values({
    code: userCode,
    user_code: userCode,
    device_code_hash: deviceCodeHash,
    status: 'pending',
    expires_at: expiresAt.toISOString(),
    user_agent: userAgent,
    ip_address: ipAddress,
  });

  return { code: userCode, userCode, deviceCode: deviceSecret, expiresAt };
}

/**
 * Get device auth request by code (legacy path).
 */
export async function getDeviceAuthRequest(code: string) {
  const [request] = await db
    .select()
    .from(device_auth_requests)
    .where(eq(device_auth_requests.code, code))
    .limit(1);

  return request;
}

/**
 * Check if a device auth request has expired.
 */
export function isDeviceAuthRequestExpired(request: {
  expires_at: string;
  status: string;
}): boolean {
  return new Date(request.expires_at) < new Date() || request.status === 'expired';
}

/**
 * Approve a device authorization request.
 */
export async function approveDeviceAuthRequest(code: string, userId: string): Promise<void> {
  const request = await getDeviceAuthRequest(code);

  if (!request) {
    throw new Error('Device authorization request not found');
  }

  if (request.status !== 'pending') {
    throw new Error('Device authorization request is not pending');
  }

  if (isDeviceAuthRequestExpired(request)) {
    await db
      .update(device_auth_requests)
      .set({ status: 'expired' })
      .where(eq(device_auth_requests.code, code));
    throw new Error('Device authorization request has expired');
  }

  await db
    .update(device_auth_requests)
    .set({
      status: 'approved',
      kilo_user_id: userId,
      approved_at: new Date().toISOString(),
    })
    .where(eq(device_auth_requests.code, code));
}

/**
 * Deny a device authorization request.
 */
export async function denyDeviceAuthRequest(code: string): Promise<void> {
  const request = await getDeviceAuthRequest(code);

  if (!request) {
    throw new Error('Device authorization request not found');
  }

  if (request.status !== 'pending') {
    throw new Error('Device authorization request is not pending');
  }

  await db
    .update(device_auth_requests)
    .set({ status: 'denied' })
    .where(eq(device_auth_requests.code, code));
}

/**
 * Atomically consume an approved request by device code.
 * Returns the appropriate status and mints a token only once per row.
 */
export async function consumeDeviceAuthByDeviceCode(
  deviceCode: string,
  options?: { supportsRefresh?: boolean }
): Promise<{
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  userId?: string;
  userEmail?: string;
}> {
  const deviceCodeHash = hashDeviceSecret(deviceCode);
  const now = new Date().toISOString();

  // Atomic consume — UPDATE … RETURNING guarantees at most one caller succeeds.
  const [consumed] = await db
    .update(device_auth_requests)
    .set({ status: 'consumed', consumed_at: now })
    .where(
      and(
        eq(device_auth_requests.device_code_hash, deviceCodeHash),
        eq(device_auth_requests.status, 'approved'),
        gt(device_auth_requests.expires_at, now),
        isNull(device_auth_requests.consumed_at)
      )
    )
    .returning();

  if (!consumed) {
    // Look up current status for the same hash.
    const [row] = await db
      .select({
        status: device_auth_requests.status,
        expires_at: device_auth_requests.expires_at,
      })
      .from(device_auth_requests)
      .where(eq(device_auth_requests.device_code_hash, deviceCodeHash))
      .limit(1);

    if (!row) return { status: 'expired' };

    if (row.status === 'expired' || new Date(row.expires_at) < new Date()) {
      return { status: 'expired' };
    }

    return { status: row.status as 'pending' | 'denied' | 'consumed' };
  }

  // Only reachable after a successful atomic consume.
  if (!consumed.kilo_user_id) {
    throw new Error('Approved request has no user');
  }

  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, consumed.kilo_user_id))
    .limit(1);

  if (!user) {
    throw new Error('User not found');
  }

  const token = options?.supportsRefresh
    ? undefined
    : generateApiToken(user, { deviceAuthRequestCode: consumed.code });

  if (options?.supportsRefresh) {
    const sessionId = await createDeviceSession({
      userId: user.id,
      userAgent: consumed.user_agent ?? undefined,
      deviceAuthRequestId: consumed.id,
    });
    const pair = await issueSessionCredentials(user, sessionId);
    return {
      status: 'approved',
      token: pair.token,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      userId: user.id,
      userEmail: user.google_user_email,
    };
  }

  return {
    status: 'approved',
    token,
    userId: user.id,
    userEmail: user.google_user_email,
  };
}

/**
 * Poll for device authorization status and return token if approved.
 * Legacy path — uses atomic consume to prevent double-spend.
 */
export async function pollDeviceAuthRequest(code: string): Promise<{
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string;
  userId?: string;
  userEmail?: string;
}> {
  const now = new Date().toISOString();

  // Atomic consume — UPDATE … RETURNING guarantees at most one caller succeeds.
  const [consumed] = await db
    .update(device_auth_requests)
    .set({ status: 'consumed', consumed_at: now })
    .where(
      and(
        eq(device_auth_requests.code, code),
        eq(device_auth_requests.status, 'approved'),
        isNotNull(device_auth_requests.kilo_user_id),
        gt(device_auth_requests.expires_at, now),
        isNull(device_auth_requests.consumed_at)
      )
    )
    .returning();

  if (consumed) {
    // Only reachable after a successful atomic consume.
    const kiloUserId = consumed.kilo_user_id;
    if (!kiloUserId) {
      throw new Error('Approved request has no user');
    }

    const [user] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, kiloUserId))
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }

    const token = generateApiToken(user, {
      deviceAuthRequestCode: consumed.code,
    });

    return {
      status: 'approved',
      token,
      userId: user.id,
      userEmail: user.google_user_email,
    };
  }

  // Fall through: not consumed, look up current status.
  const [request] = await db
    .select()
    .from(device_auth_requests)
    .where(eq(device_auth_requests.code, code))
    .limit(1);

  // Normalize response: return 'expired' for non-existent codes to prevent enumeration
  if (!request) {
    return { status: 'expired' };
  }

  // Check expiration
  if (isDeviceAuthRequestExpired(request)) {
    if (request.status !== 'expired') {
      await db
        .update(device_auth_requests)
        .set({ status: 'expired' })
        .where(eq(device_auth_requests.code, code));
    }
    return { status: 'expired' };
  }

  // Return status for non-approved requests (or already-consumed)
  if (request.status === 'consumed') {
    return { status: 'expired' };
  }

  return { status: request.status as 'pending' | 'denied' };
}

/**
 * Clean up expired device auth requests.
 * Should be called periodically (e.g., via cron job).
 */
export async function cleanupExpiredDeviceAuthRequests(): Promise<number> {
  const result = await db
    .delete(device_auth_requests)
    .where(lt(device_auth_requests.expires_at, new Date().toISOString()))
    .returning({ id: device_auth_requests.id });

  return result.length;
}
