import 'server-only';
import { db } from '@/lib/drizzle';
import { device_auth_requests, kilocode_users } from '@kilocode/db/schema';
import { eq, and, lt, sql } from 'drizzle-orm';
import { generateApiToken } from '@/lib/tokens';
import { randomBytes } from 'node:crypto';

const CODE_LENGTH = 8;
const CODE_EXPIRATION_MINUTES = 10;
const MAX_PENDING_REQUESTS_PER_IP = 5;

/**
 * Generate a random device authorization code
 * Uses only unambiguous characters for better UX
 */
export function generateDeviceCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < buf.length; i++) {
    const index = buf[i] % chars.length;
    code += chars[index];
  }
  // Format as XXXX-XXXX (8 characters total)
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Create a new device authorization request
 */
export async function createDeviceAuthRequest(params: {
  userAgent?: string;
  ipAddress?: string;
}): Promise<{ code: string; expiresAt: Date }> {
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

  const code = generateDeviceCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

  await db.insert(device_auth_requests).values({
    code,
    status: 'pending',
    expires_at: expiresAt.toISOString(),
    user_agent: userAgent,
    ip_address: ipAddress,
  });

  return { code, expiresAt };
}

/**
 * Get device auth request by code
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
 * Check if a device auth request has expired
 */
export function isDeviceAuthRequestExpired(request: {
  expires_at: string;
  status: string;
}): boolean {
  return new Date(request.expires_at) < new Date() || request.status === 'expired';
}

/**
 * Approve a device authorization request
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
 * Deny a device authorization request
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
 * Poll for device authorization status and return token if approved
 * Implements single-use token enforcement
 */
export async function pollDeviceAuthRequest(code: string): Promise<{
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string;
  userId?: string;
  userEmail?: string;
}> {
  const request = await getDeviceAuthRequest(code);

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

  // Return status for non-approved requests
  if (request.status !== 'approved' || !request.kilo_user_id) {
    return { status: request.status as 'pending' | 'denied' };
  }

  // For approved requests, fetch user and generate token
  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, request.kilo_user_id))
    .limit(1);

  if (!user) {
    throw new Error('User not found');
  }

  const token = generateApiToken(user, { deviceAuthRequestCode: code });

  // Mark as consumed to enforce single-use
  await db
    .update(device_auth_requests)
    .set({
      status: 'expired',
    })
    .where(eq(device_auth_requests.code, code));

  return {
    status: 'approved',
    token,
    userId: user.id,
    userEmail: user.google_user_email,
  };
}

/**
 * Clean up expired device auth requests
 * Should be called periodically (e.g., via cron job)
 */
export async function cleanupExpiredDeviceAuthRequests(): Promise<number> {
  const result = await db
    .delete(device_auth_requests)
    .where(lt(device_auth_requests.expires_at, new Date().toISOString()))
    .returning({ id: device_auth_requests.id });

  return result.length;
}
