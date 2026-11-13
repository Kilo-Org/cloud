import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_auth_requests, device_sessions, kilocode_users } from '@kilocode/db/schema';
import { eq, and, lt, lte, gt, isNull, isNotNull, sql } from 'drizzle-orm';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { randomInt, createHash, randomBytes } from 'node:crypto';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { requestingClientOfRow, type RequestingClient } from './requesting-client';
import {
  completePendingLinkByHash,
  getLivePendingLinkByHash,
  hashPendingLinkSecret,
  type PendingLinkResult,
} from '@/lib/auth/pending-link';
import type { AuthProviderId } from '@kilocode/db/schema-types';

async function completeStoredPendingLink(
  secretHash: string | null,
  userId: string
): Promise<PendingLinkResult | undefined> {
  if (!secretHash) return undefined;
  try {
    return await completePendingLinkByHash(secretHash, userId);
  } catch {
    return { status: 'failed', reason: 'LINKING-FAILED' };
  }
}

export type { RequestingClient } from './requesting-client';

/**
 * Refusal when the approval does not confirm the client the request names. The
 * approval page shows the client, the approver confirms that exact client, and
 * a request that names one is never approved without it.
 */
export const DEVICE_AUTH_CLIENT_CONFIRMATION_MESSAGE =
  'Device authorization client confirmation does not match';

/**
 * Refusal when an approval for a request carrying a live pending link does
 * not say whether to attach it. The approval page offers both choices and
 * preselects neither, so an approval without the choice is incomplete.
 */
export const DEVICE_AUTH_PENDING_LINK_CHOICE_MESSAGE =
  'Device authorization pending link choice is required';

export type DeviceAuthPendingLink = {
  provider: AuthProviderId;
  email: string;
  displayName: string | null;
};

/** The live pending link a device request carries, for the approval page. */
export async function getDeviceAuthPendingLink(
  userCode: string
): Promise<DeviceAuthPendingLink | null> {
  const request = await getDeviceAuthRequest(userCode);
  if (
    !request ||
    request.status !== 'pending' ||
    isDeviceAuthRequestExpired(request) ||
    !request.pending_link_secret_hash
  ) {
    return null;
  }
  const pending = await getLivePendingLinkByHash(request.pending_link_secret_hash);
  if (!pending) return null;
  return {
    provider: pending.provider,
    email: pending.email,
    displayName: pending.display_name,
  };
}

const CODE_LENGTH = 8;
const CODE_EXPIRATION_MINUTES = 10;
const MAX_PENDING_REQUESTS_PER_IP = 5;
const MAX_USER_CODE_ATTEMPTS = 5;
/** Advisory-lock namespace for the per-address pending count and insert. */
const PENDING_LIMIT_LOCK_NAMESPACE = 'device_auth_request_pending';
/**
 * Bound on the wait for the per-address lock.
 *
 * A request holds a database connection while it waits for the lock, so the wait
 * is bounded and a request that cannot take the lock within the bound is refused
 * with {@link DeviceAuthPendingLimitError}. The bound is far longer than the
 * serialized section it guards (one count plus one insert).
 */
export const DEVICE_AUTH_PENDING_LOCK_WAIT_MS = 5_000;
/** SQLSTATE of a statement cancelled because it waited for a lock too long. */
const LOCK_NOT_AVAILABLE = '55P03';

export const DEVICE_AUTH_PENDING_LIMIT_MESSAGE =
  'Too many sign-in attempts from this network. Wait a few minutes and try again.';

/** Rate-limit error thrown when an IP has too many live pending requests. */
export class DeviceAuthPendingLimitError extends Error {
  constructor() {
    super(DEVICE_AUTH_PENDING_LIMIT_MESSAGE);
    this.name = 'DeviceAuthPendingLimitError';
  }
}

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
 *
 * `code` is a high-entropy poll secret kept by the requesting client, while
 * `user_code` is the short code shown to the user and typed into the approval
 * page. `device_code_hash` covers the device secret used by the newer
 * device-code flow.
 *
 * A request that already has `MAX_PENDING_REQUESTS_PER_IP` live pending rows from
 * the same address is refused before any row is written. The count and the insert
 * run inside one transaction that holds a per-address advisory lock, so the limit
 * is evaluated against the rows committed by the requests that came before.
 * `pg_advisory_xact_lock` releases on commit or rollback, so the lock never
 * outlives the transaction. The wait for that lock is bounded by
 * {@link DEVICE_AUTH_PENDING_LOCK_WAIT_MS}; a request that cannot take the lock
 * within the bound is refused with {@link DeviceAuthPendingLimitError}.
 */
export async function createDeviceAuthRequest(params: {
  userAgent?: string;
  ipAddress?: string;
  requestingClient?: RequestingClient;
  pendingLinkToken?: string;
}): Promise<{
  code: string;
  userCode: string;
  deviceCode: string;
  expiresAt: Date;
  requestingClient: RequestingClient | null;
}> {
  const { userAgent, ipAddress, requestingClient = null } = params;

  // Validate IP address on Production
  if (process.env['NODE_ENV'] === 'production' && !ipAddress) {
    throw new Error('IP address is required in production');
  }

  const pollSecret = generateDeviceSecret();
  const deviceSecret = generateDeviceSecret();
  const deviceCodeHash = hashDeviceSecret(deviceSecret);
  const expiresAt = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

  try {
    return await db.transaction(async tx => {
      if (ipAddress) {
        // The wait for the address lock below is bounded: a request that cannot
        // take it within the bound is refused with the pending-limit error.
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${DEVICE_AUTH_PENDING_LOCK_WAIT_MS}'`));

        // The count and the insert below are one serialized unit for this
        // address. The first key namespaces the surface so it cannot contend with
        // another feature's advisory locks.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${PENDING_LIMIT_LOCK_NAMESPACE}), hashtext(${ipAddress}))`
        );

        const [result] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(device_auth_requests)
          .where(
            and(
              eq(device_auth_requests.ip_address, ipAddress),
              eq(device_auth_requests.status, 'pending'),
              gt(device_auth_requests.expires_at, new Date().toISOString())
            )
          );

        if (result && result.count >= MAX_PENDING_REQUESTS_PER_IP) {
          throw new DeviceAuthPendingLimitError();
        }
      }

      for (let attempt = 0; attempt < MAX_USER_CODE_ATTEMPTS; attempt++) {
        const userCode = generateUserCode();
        const [inserted] = await tx
          .insert(device_auth_requests)
          .values({
            code: pollSecret,
            user_code: userCode,
            device_code_hash: deviceCodeHash,
            status: 'pending',
            expires_at: expiresAt.toISOString(),
            user_agent: userAgent,
            ip_address: ipAddress,
            pending_link_secret_hash: params.pendingLinkToken
              ? hashPendingLinkSecret(params.pendingLinkToken)
              : null,
            ...requestingClientColumns(requestingClient),
          })
          .onConflictDoNothing({
            target: device_auth_requests.user_code,
            where: sql`${device_auth_requests.user_code} IS NOT NULL`,
          })
          .returning({ id: device_auth_requests.id });

        if (inserted) {
          return {
            code: pollSecret,
            userCode,
            deviceCode: deviceSecret,
            expiresAt,
            requestingClient,
          };
        }
      }

      throw new Error('Unable to allocate a device authorization user code');
    });
  } catch (error) {
    // A wait that exceeds the bound gets the same refusal as a caller at the
    // limit: the address's lock is held by requests that are still in flight.
    if (isLockWaitTimeout(error)) throw new DeviceAuthPendingLimitError();
    throw error;
  }
}

/**
 * Whether the failure is a statement cancelled by `lock_timeout`. Drizzle wraps
 * query errors, so the SQLSTATE sits on the wrapped cause rather than the thrown
 * error.
 */
function isLockWaitTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') return false;
    if ('code' in current && current.code === LOCK_NOT_AVAILABLE) return true;
    if (!('cause' in current)) return false;
    current = current.cause;
  }
  return false;
}

function requestingClientColumns(client: RequestingClient | null): {
  requesting_client_id: string | null;
  requesting_client_name: string | null;
  requesting_redirect_origin: string | null;
} {
  return {
    requesting_client_id: client?.clientId ?? null,
    requesting_client_name: client?.clientName ?? null,
    requesting_redirect_origin: client?.redirectOrigin ?? null,
  };
}

/**
 * Get a device auth request by its displayed user code (approval side).
 */
export async function getDeviceAuthRequest(userCode: string) {
  const [request] = await db
    .select()
    .from(device_auth_requests)
    .where(eq(device_auth_requests.user_code, userCode))
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
 * Approve a device authorization request by its displayed user code.
 */
export async function approveDeviceAuthRequest(
  userCode: string,
  userId: string,
  options: { confirmedClientId?: string; addPendingLink?: boolean } = {}
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getDeviceAuthRequest(userCode);
  const requestingClientId = existing?.requesting_client_id ?? null;
  const actionable =
    existing?.status === 'pending' && new Date(existing.expires_at).getTime() > Date.parse(now);
  // An actionable row that names a client requires its confirmation before any
  // other outcome is considered; an expired row reports its expiry below.
  const confirmed =
    requestingClientId !== null && actionable
      ? confirmRequestingClient(requestingClientId, options.confirmedClientId)
      : false;

  // A live pending link must never attach silently: an actionable row that
  // carries one requires the approver's explicit choice. Declining clears
  // the stored hash so consumption cannot attach it later.
  let clearPendingLink = false;
  if (actionable && existing && existing.pending_link_secret_hash) {
    const livePending = await getLivePendingLinkByHash(existing.pending_link_secret_hash);
    if (livePending) {
      if (options.addPendingLink === undefined) {
        throw new Error(DEVICE_AUTH_PENDING_LINK_CHOICE_MESSAGE);
      }
      clearPendingLink = options.addPendingLink === false;
    }
  }

  const [approved] = await db
    .update(device_auth_requests)
    .set({
      status: 'approved',
      kilo_user_id: userId,
      approved_at: now,
      ...(confirmed ? { client_confirmed_at: now } : {}),
      ...(clearPendingLink ? { pending_link_secret_hash: null } : {}),
    })
    .where(
      and(
        eq(device_auth_requests.user_code, userCode),
        eq(device_auth_requests.status, 'pending'),
        gt(device_auth_requests.expires_at, now)
      )
    )
    .returning({ id: device_auth_requests.id });

  if (approved) {
    return;
  }

  const request = await getDeviceAuthRequest(userCode);

  if (!request) {
    throw new Error('Device authorization request not found');
  }

  if (request.status !== 'pending') {
    throw new Error('Device authorization request is not pending');
  }

  const [expired] = await db
    .update(device_auth_requests)
    .set({ status: 'expired' })
    .where(
      and(
        eq(device_auth_requests.user_code, userCode),
        eq(device_auth_requests.status, 'pending'),
        lte(device_auth_requests.expires_at, now)
      )
    )
    .returning({ id: device_auth_requests.id });

  if (!expired) {
    throw new Error('Device authorization request is not pending');
  }
  throw new Error('Device authorization request has expired');
}

function confirmRequestingClient(requestingClientId: string, confirmedClientId?: string): true {
  if (confirmedClientId !== requestingClientId) {
    throw new Error(DEVICE_AUTH_CLIENT_CONFIRMATION_MESSAGE);
  }
  return true;
}

/**
 * Deny a device authorization request by its displayed user code.
 */
export async function denyDeviceAuthRequest(userCode: string): Promise<void> {
  const request = await getDeviceAuthRequest(userCode);

  if (!request) {
    throw new Error('Device authorization request not found');
  }

  if (request.status !== 'pending') {
    throw new Error('Device authorization request is not pending');
  }

  const [denied] = await db
    .update(device_auth_requests)
    .set({ status: 'denied' })
    .where(
      and(eq(device_auth_requests.user_code, userCode), eq(device_auth_requests.status, 'pending'))
    )
    .returning({ id: device_auth_requests.id });

  if (!denied) {
    throw new Error('Device authorization request is not pending');
  }
}

/**
 * Cancel a request from the device that started it. The poll secret is that
 * device's proof of ownership: it already authorises polling the request and
 * no browser session exists in the client that started it.
 */
export async function cancelDeviceAuthRequest(code: string): Promise<void> {
  const [cancelled] = await db
    .update(device_auth_requests)
    .set({ status: 'denied' })
    .where(and(eq(device_auth_requests.code, code), eq(device_auth_requests.status, 'pending')))
    .returning({ id: device_auth_requests.id });

  if (cancelled) {
    return;
  }

  const [request] = await db
    .select({ status: device_auth_requests.status })
    .from(device_auth_requests)
    .where(eq(device_auth_requests.code, code))
    .limit(1);

  if (!request) {
    throw new Error('Device authorization request not found');
  }

  // A request the approver denied, or that already expired, is cancelled.
  if (request.status === 'denied' || request.status === 'expired') {
    return;
  }

  throw new Error('Device authorization request is not pending');
}

/**
 * Atomically consume an approved request by device code.
 * Returns the appropriate status and mints a token only once per row.
 *
 * If credential issuance fails after the atomic consume succeeds, the row is
 * restored to `approved` so the request remains redeemable.
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
  pendingLink?: PendingLinkResult;
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

  let sessionId: string | undefined;
  try {
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

    if (isBlockedAccount(user)) {
      await db
        .update(device_auth_requests)
        .set({ status: 'denied' })
        .where(eq(device_auth_requests.code, consumed.code));
      return { status: 'denied' };
    }

    const token = options?.supportsRefresh
      ? undefined
      : generateApiToken(user, { deviceAuthRequestCode: consumed.code });

    if (options?.supportsRefresh) {
      sessionId = await createDeviceSession({
        userId: user.id,
        userAgent: consumed.user_agent ?? undefined,
        deviceAuthRequestId: consumed.id,
      });
      const pair = await issueSessionCredentials(user, sessionId);
      // The pending link completes only after credentials exist, so a
      // restored row never reports a link result for an attach that the
      // retry would then find already consumed.
      const pendingLink = await completeStoredPendingLink(
        consumed.pending_link_secret_hash,
        user.id
      );
      return {
        status: 'approved',
        token: pair.token,
        refreshToken: pair.refreshToken,
        expiresIn: pair.expiresIn,
        userId: user.id,
        userEmail: user.google_user_email,
        ...(pendingLink ? { pendingLink } : {}),
      };
    }

    const pendingLink = await completeStoredPendingLink(consumed.pending_link_secret_hash, user.id);
    return {
      status: 'approved',
      token,
      userId: user.id,
      userEmail: user.google_user_email,
      ...(pendingLink ? { pendingLink } : {}),
    };
  } catch (err) {
    // If a device session was created, delete it to avoid orphans.
    if (sessionId) {
      await db.delete(device_sessions).where(eq(device_sessions.id, sessionId));
    }
    // Restore the row so the request remains redeemable.
    await db
      .update(device_auth_requests)
      .set({ status: 'approved', consumed_at: null })
      .where(
        and(eq(device_auth_requests.id, consumed.id), eq(device_auth_requests.status, 'consumed'))
      );
    throw err;
  }
}

/**
 * Poll for device authorization status and return token if approved.
 * Legacy path — keyed on the high-entropy poll secret stored in `code`.
 * Uses atomic consume to prevent double-spend.
 *
 * If credential issuance fails after the atomic consume succeeds, the row is
 * restored to `approved` so the request remains redeemable.
 */
export async function pollDeviceAuthRequest(code: string): Promise<{
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string;
  userId?: string;
  userEmail?: string;
  /** The client the request named, when it named one. */
  requestingClient?: RequestingClient | null;
  /** Whether the approval confirmed that exact client. */
  clientConfirmed?: boolean;
  pendingLink?: PendingLinkResult;
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
    try {
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

      if (isBlockedAccount(user)) {
        await db
          .update(device_auth_requests)
          .set({ status: 'denied' })
          .where(eq(device_auth_requests.code, code));
        return { status: 'denied' };
      }

      const token = generateApiToken(user, {
        deviceAuthRequestCode: consumed.code,
      });
      const pendingLink = await completeStoredPendingLink(
        consumed.pending_link_secret_hash,
        user.id
      );

      return {
        status: 'approved',
        token,
        userId: user.id,
        userEmail: user.google_user_email,
        requestingClient: requestingClientOfRow(consumed),
        clientConfirmed: consumed.client_confirmed_at !== null,
        ...(pendingLink ? { pendingLink } : {}),
      };
    } catch (err) {
      // Restore the row so the request remains redeemable.
      await db
        .update(device_auth_requests)
        .set({ status: 'approved', consumed_at: null })
        .where(
          and(eq(device_auth_requests.id, consumed.id), eq(device_auth_requests.status, 'consumed'))
        );
      throw err;
    }
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
