import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_auth_requests, device_sessions, kilocode_users } from '@kilocode/db/schema';
import { eq, and, gt, isNull, isNotNull, not, sql, type SQL } from 'drizzle-orm';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { randomInt, createHash, randomBytes } from 'node:crypto';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { requestingClientOfRow, type RequestingClient } from './requesting-client';
import {
  getLivePendingLinkByHash,
  hashPendingLinkSecret,
  resolveStoredPendingLinkForUser,
  type PendingLinkResult,
} from '@/lib/auth/pending-link';
import type { AuthProviderId } from '@kilocode/db/schema-types';

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

type DeviceAuthRequestRow = typeof device_auth_requests.$inferSelect;
type DeviceAuthUserRow = typeof kilocode_users.$inferSelect;
type DeviceAuthRequestStatus = DeviceAuthRequestRow['status'];

/**
 * The one device-request expiry rule: a request is live while its deadline is
 * after the instant, so it expires at the deadline. The approval action, both
 * redemption predicates, the approval page and cleanup compare with it.
 */
function isExpiredAt(expiresAt: string, now = new Date().toISOString()): boolean {
  return new Date(expiresAt).getTime() <= Date.parse(now);
}

/** The same rule as a query condition: the rows that are still live. */
function requestIsLiveAt(now: string): SQL {
  return gt(device_auth_requests.expires_at, now);
}

/**
 * Check if a device auth request has expired. This is the expiry rule.
 *
 * `now` is the instant the caller acts on, so a caller that also writes with a
 * captured instant decides liveness against that same instant and a request it
 * refuses is never approved later in the same call.
 */
export function isDeviceAuthRequestExpired(
  request: {
    expires_at: string;
    status: DeviceAuthRequestStatus;
  },
  now = new Date().toISOString()
): boolean {
  return request.status === 'expired' || isExpiredAt(request.expires_at, now);
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
  const actionable = existing?.status === 'pending' && !isDeviceAuthRequestExpired(existing, now);
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
        requestIsLiveAt(now)
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
        not(requestIsLiveAt(now))
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
 * The outcome of the shared redemption pipeline. Each redeemer maps it into its
 * own response, because their status vocabularies and extra fields differ.
 */
type RedeemOutcome<TCredentials> =
  | {
      outcome: 'redeemed';
      credentials: TCredentials;
      request: DeviceAuthRequestRow;
      pendingLink?: PendingLinkResult;
    }
  | { outcome: 'denied' }
  | { outcome: 'not-redeemed'; status: DeviceAuthRequestStatus };

/**
 * The current status of a request a caller could not consume. A request past
 * its deadline is marked expired here, so both redeemers leave the same state.
 */
async function describeNotRedeemed(identity: SQL): Promise<RedeemOutcome<never>> {
  const [request] = await db.select().from(device_auth_requests).where(identity).limit(1);

  // A missing row reports expired too, so a caller cannot enumerate requests.
  if (!request) return { outcome: 'not-redeemed', status: 'expired' };

  if (!isDeviceAuthRequestExpired(request)) {
    return { outcome: 'not-redeemed', status: request.status };
  }

  if (request.status !== 'expired') {
    await db
      .update(device_auth_requests)
      .set({ status: 'expired' })
      .where(eq(device_auth_requests.id, request.id));
  }
  return { outcome: 'not-redeemed', status: 'expired' };
}

/**
 * The one redemption pipeline both redeemers use. It owns the atomic consume,
 * the current-status fallback, the user lookup, the blocked-account denial, the
 * restore on throw and the pending-link completion. Each caller supplies the
 * row it redeems, how it mints its credentials, and what to release if minting
 * throws.
 */
async function redeemApprovedRequest<TCredentials>(params: {
  /** Identifies the single row this caller redeems: its device-code hash, or its poll secret. */
  identity: SQL;
  /** Extra consume condition; the legacy poll redeems only a request that names its user. */
  consumeGuard?: SQL;
  mint: (context: {
    user: DeviceAuthUserRow;
    request: DeviceAuthRequestRow;
  }) => Promise<TCredentials>;
  /** Releases what the mint created, before the row becomes redeemable again. */
  discard?: () => Promise<void>;
}): Promise<RedeemOutcome<TCredentials>> {
  const now = new Date().toISOString();

  // Atomic consume — UPDATE … RETURNING guarantees at most one caller succeeds.
  const [consumed] = await db
    .update(device_auth_requests)
    .set({ status: 'consumed', consumed_at: now })
    .where(
      and(
        params.identity,
        params.consumeGuard,
        eq(device_auth_requests.status, 'approved'),
        requestIsLiveAt(now),
        isNull(device_auth_requests.consumed_at)
      )
    )
    .returning();

  if (!consumed) {
    return describeNotRedeemed(params.identity);
  }

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
        .where(eq(device_auth_requests.id, consumed.id));
      return { outcome: 'denied' };
    }

    const credentials = await params.mint({ user, request: consumed });

    // The pending link completes only after credentials exist, so a restored
    // row never reports a link result for an attach that the retry would then
    // find already consumed.
    const pendingLink = await resolveStoredPendingLinkForUser(
      consumed.pending_link_secret_hash,
      user.id
    );

    return {
      outcome: 'redeemed',
      credentials,
      request: consumed,
      ...(pendingLink ? { pendingLink } : {}),
    };
  } catch (err) {
    await params.discard?.();
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
 * Atomically consume an approved request by device code.
 * Returns the appropriate status and mints a token only once per row.
 *
 * Redemption goes through the shared pipeline, so a failed mint restores the
 * row to `approved` and the request remains redeemable.
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
  let sessionId: string | undefined;

  const outcome = await redeemApprovedRequest<{
    token: string;
    refreshToken?: string;
    expiresIn?: number;
    userId: string;
    userEmail: string;
  }>({
    identity: eq(device_auth_requests.device_code_hash, hashDeviceSecret(deviceCode)),
    mint: async ({ user, request }) => {
      if (!options?.supportsRefresh) {
        return {
          token: generateApiToken(user, { deviceAuthRequestCode: request.code }),
          userId: user.id,
          userEmail: user.google_user_email,
        };
      }
      sessionId = await createDeviceSession({
        userId: user.id,
        userAgent: request.user_agent ?? undefined,
        deviceAuthRequestId: request.id,
      });
      const pair = await issueSessionCredentials(user, sessionId);
      return {
        token: pair.token,
        refreshToken: pair.refreshToken,
        expiresIn: pair.expiresIn,
        userId: user.id,
        userEmail: user.google_user_email,
      };
    },
    discard: async () => {
      if (sessionId) {
        await db.delete(device_sessions).where(eq(device_sessions.id, sessionId));
      }
    },
  });

  switch (outcome.outcome) {
    case 'redeemed':
      return {
        status: 'approved',
        ...outcome.credentials,
        ...(outcome.pendingLink ? { pendingLink: outcome.pendingLink } : {}),
      };
    case 'denied':
      return { status: 'denied' };
    case 'not-redeemed':
      return { status: outcome.status };
  }
}

/**
 * Poll for device authorization status and return token if approved.
 * Legacy path — keyed on the high-entropy poll secret stored in `code`.
 * Redeems through the shared pipeline, which consumes atomically to prevent
 * double-spend and restores the row to `approved` when minting fails.
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
  const outcome = await redeemApprovedRequest<{
    token: string;
    userId: string;
    userEmail: string;
  }>({
    identity: eq(device_auth_requests.code, code),
    consumeGuard: isNotNull(device_auth_requests.kilo_user_id),
    mint: async ({ user, request }) => ({
      token: generateApiToken(user, { deviceAuthRequestCode: request.code }),
      userId: user.id,
      userEmail: user.google_user_email,
    }),
  });

  switch (outcome.outcome) {
    case 'redeemed':
      return {
        status: 'approved',
        ...outcome.credentials,
        requestingClient: requestingClientOfRow(outcome.request),
        clientConfirmed: outcome.request.client_confirmed_at !== null,
        ...(outcome.pendingLink ? { pendingLink: outcome.pendingLink } : {}),
      };
    case 'denied':
      return { status: 'denied' };
    case 'not-redeemed':
      // A consumed request is spent, so the legacy response reports it expired.
      return { status: outcome.status === 'consumed' ? 'expired' : outcome.status };
  }
}

/**
 * Clean up expired device auth requests.
 * Should be called periodically (e.g., via cron job).
 */
export async function cleanupExpiredDeviceAuthRequests(): Promise<number> {
  const result = await db
    .delete(device_auth_requests)
    .where(not(requestIsLiveAt(new Date().toISOString())))
    .returning({ id: device_auth_requests.id });

  return result.length;
}
