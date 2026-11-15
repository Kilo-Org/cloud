import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import {
  device_sessions,
  kilocode_users,
  passkey_management_authorizations,
} from '@kilocode/db/schema';
import { db, type DrizzleConnection } from '@kilocode/web-shared/lib/drizzle';
import { liveDeviceSessionCondition } from '@kilocode/web-shared/lib/auth/device-session-condition';

/** The one passkey-management action a grant authorizes. */
export type PasskeyManagementOperation = 'enroll' | 'rename' | 'remove';

/**
 * A management grant is redeemed within minutes of the primary proof that
 * minted it. The window covers the platform ceremony after the options step,
 * and nothing else: an abandoned or cancelled ceremony simply expires.
 */
export const PASSKEY_MANAGEMENT_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

const AUTHORIZATION_TOKEN_BYTES = 32;

/**
 * The grant is a bearer secret handed to one app session, so only its digest
 * is stored. Minting and consuming share this derivation, so they cannot
 * disagree about which row a token names.
 */
function hashAuthorizationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The account's current pepper, correlated to the account in the same
 * statement, so a concurrent update cannot pair one account with another's
 * pepper. Account recovery rotates it.
 */
function accountWebSessionPepper(userId: string): SQL {
  return sql`(SELECT ${kilocode_users.web_session_pepper} FROM ${kilocode_users} WHERE ${kilocode_users.id} = ${userId})`;
}

/** A grant minted under one pepper authorizes nothing under another. */
function pepperMatchesAccount(userId: string): SQL {
  return sql`${passkey_management_authorizations.web_session_pepper} IS NOT DISTINCT FROM ${accountWebSessionPepper(userId)}`;
}

/**
 * The rows that match a presented grant. The device session is part of the
 * condition, so a grant is unusable once its session is revoked and can never
 * be replayed from another session of the same account.
 *
 * The session must be live and owned by the account. Nothing narrower: the app
 * mints its own sessions through the browser device-auth flow, which sets
 * `device_auth_request_id` (see `device-session-client.ts`), and the column is
 * a record of that sign-in rather than a client kind. The authority here is the
 * grant, which only a fresh primary proof for this account and session mints.
 */
function authorizationMatches(params: {
  tokenHash: string;
  userId: string;
  deviceSessionId: string;
  operation: PasskeyManagementOperation;
  challengeId?: string;
}) {
  return and(
    eq(passkey_management_authorizations.token_hash, params.tokenHash),
    eq(passkey_management_authorizations.state, 'issued'),
    eq(passkey_management_authorizations.kilo_user_id, params.userId),
    eq(passkey_management_authorizations.device_session_id, params.deviceSessionId),
    eq(passkey_management_authorizations.operation, params.operation),
    isNull(passkey_management_authorizations.consumed_at),
    sql`${passkey_management_authorizations.expires_at} > NOW()`,
    ...(params.challengeId === undefined
      ? []
      : [eq(passkey_management_authorizations.passkey_challenge_id, params.challengeId)]),
    // Account recovery rotates the pepper on the user row. A grant minted
    // under the previous one authorizes nothing afterwards.
    pepperMatchesAccount(params.userId),
    sql`EXISTS (
      SELECT 1 FROM ${device_sessions}
      WHERE ${liveDeviceSessionCondition({ deviceSessionId: params.deviceSessionId, userId: params.userId })}
    )`
  );
}

export type MintedPasskeyManagementAuthorization = {
  id: string;
  token: string;
  operation: PasskeyManagementOperation;
  expiresIn: number;
};

/**
 * Mint a single-use grant for one passkey-management operation. Callers must
 * have established a fresh primary proof for `userId` first; this function
 * itself authorizes nothing.
 */
export async function mintPasskeyManagementAuthorization(params: {
  userId: string;
  deviceSessionId: string;
  operation: PasskeyManagementOperation;
}): Promise<MintedPasskeyManagementAuthorization> {
  const token = randomBytes(AUTHORIZATION_TOKEN_BYTES).toString('base64url');

  const [row] = await db
    .insert(passkey_management_authorizations)
    .values({
      token_hash: hashAuthorizationToken(token),
      kilo_user_id: params.userId,
      device_session_id: params.deviceSessionId,
      operation: params.operation,
      state: 'issued',
      web_session_pepper: accountWebSessionPepper(params.userId),
      expires_at: new Date(Date.now() + PASSKEY_MANAGEMENT_AUTHORIZATION_TTL_MS).toISOString(),
    })
    .returning({ id: passkey_management_authorizations.id });

  if (!row) {
    throw new Error('Passkey management authorization insert returned no row');
  }

  return {
    id: row.id,
    token,
    operation: params.operation,
    expiresIn: Math.floor(PASSKEY_MANAGEMENT_AUTHORIZATION_TTL_MS / 1000),
  };
}

/**
 * Delete a grant minted by an operation that did not complete, so a failed
 * settlement never leaves a usable authorization behind.
 */
export async function discardPasskeyManagementAuthorization(id: string): Promise<void> {
  await db
    .delete(passkey_management_authorizations)
    .where(eq(passkey_management_authorizations.id, id));
}

/**
 * How long the app may wait for the browser half of an SSO proof. It covers
 * the sign-in itself, and nothing else: an abandoned approval expires.
 */
export const PASSKEY_MANAGEMENT_SSO_REQUEST_TTL_MS = 10 * 60 * 1000;

export type PasskeyManagementSsoRequest = {
  /** Public identifier the app polls with and the browser approves. */
  requestId: string;
  operation: PasskeyManagementOperation;
  expiresIn: number;
};

/**
 * Start an SSO proof. The row is `pending`: it authorizes nothing, so the app
 * can hold its id and the browser can hold it in a URL. The approving browser
 * session must be signed in to `ssoOrganizationId`, the organization the
 * account's domain currently requires.
 */
export async function createPasskeyManagementSsoRequest(params: {
  userId: string;
  deviceSessionId: string;
  operation: PasskeyManagementOperation;
  ssoOrganizationId: string;
}): Promise<PasskeyManagementSsoRequest> {
  const [row] = await db
    .insert(passkey_management_authorizations)
    .values({
      kilo_user_id: params.userId,
      device_session_id: params.deviceSessionId,
      operation: params.operation,
      state: 'pending',
      sso_organization_id: params.ssoOrganizationId,
      web_session_pepper: accountWebSessionPepper(params.userId),
      expires_at: new Date(Date.now() + PASSKEY_MANAGEMENT_SSO_REQUEST_TTL_MS).toISOString(),
    })
    .returning({
      id: passkey_management_authorizations.id,
      operation: passkey_management_authorizations.operation,
    });

  if (!row) {
    throw new Error('Passkey management SSO request insert returned no row');
  }

  return {
    requestId: row.id,
    operation: row.operation,
    expiresIn: Math.floor(PASSKEY_MANAGEMENT_SSO_REQUEST_TTL_MS / 1000),
  };
}

export type PendingPasskeyManagementSsoRequest = {
  state: 'pending' | 'approved';
  operation: PasskeyManagementOperation;
  /** The organization the approval was recorded under. */
  ssoOrganizationId: string | null;
};

/**
 * Read an SSO request the app started, scoped to the account and the device
 * session it was started from. A row that expired, was collected, or belongs
 * to another session reads as absent.
 */
export async function readPasskeyManagementSsoRequest(params: {
  requestId: string;
  userId: string;
  deviceSessionId: string;
}): Promise<PendingPasskeyManagementSsoRequest | null> {
  const [row] = await db
    .select({
      state: passkey_management_authorizations.state,
      operation: passkey_management_authorizations.operation,
      ssoOrganizationId: passkey_management_authorizations.sso_organization_id,
    })
    .from(passkey_management_authorizations)
    .where(
      and(
        eq(passkey_management_authorizations.id, params.requestId),
        eq(passkey_management_authorizations.kilo_user_id, params.userId),
        eq(passkey_management_authorizations.device_session_id, params.deviceSessionId),
        ne(passkey_management_authorizations.state, 'issued'),
        sql`${passkey_management_authorizations.expires_at} > NOW()`
      )
    )
    .limit(1);

  if (!row || row.state === 'issued') {
    return null;
  }

  return {
    state: row.state,
    operation: row.operation,
    ssoOrganizationId: row.ssoOrganizationId,
  };
}

/**
 * Record the browser's approval of one SSO request. The browser must be signed
 * in to the same account and to the required organization, and the request
 * must still be pending and unexpired. Account recovery rotates the pepper, so
 * a request started before recovery cannot be approved after it.
 *
 * Returns the operation the request authorizes, or null when nothing matched.
 */
export async function approvePasskeyManagementSsoRequest(params: {
  requestId: string;
  userId: string;
  ssoOrganizationId: string;
}): Promise<PasskeyManagementOperation | null> {
  const [approved] = await db
    .update(passkey_management_authorizations)
    .set({ state: 'approved', approved_at: sql`NOW()` })
    .where(
      and(
        eq(passkey_management_authorizations.id, params.requestId),
        eq(passkey_management_authorizations.kilo_user_id, params.userId),
        eq(passkey_management_authorizations.sso_organization_id, params.ssoOrganizationId),
        eq(passkey_management_authorizations.state, 'pending'),
        sql`${passkey_management_authorizations.expires_at} > NOW()`,
        pepperMatchesAccount(params.userId)
      )
    )
    .returning({ operation: passkey_management_authorizations.operation });

  return approved?.operation ?? null;
}

export type CollectedPasskeyManagementGrant = {
  token: string;
  operation: PasskeyManagementOperation;
  expiresIn: number;
};

/**
 * Exchange an approved SSO request for its grant, exactly once. The exchange
 * is atomic and runs in one transaction that also locks the device session, so
 * a concurrent revocation either lands before the grant is issued or waits for
 * it, and only one caller can collect.
 */
export async function collectPasskeyManagementSsoGrant(params: {
  requestId: string;
  userId: string;
  deviceSessionId: string;
}): Promise<CollectedPasskeyManagementGrant | null> {
  const token = randomBytes(AUTHORIZATION_TOKEN_BYTES).toString('base64url');

  const collected = await db.transaction(async tx => {
    const [session] = await tx
      .select({ id: device_sessions.id })
      .from(device_sessions)
      .where(
        liveDeviceSessionCondition({
          deviceSessionId: params.deviceSessionId,
          userId: params.userId,
        })
      )
      .limit(1)
      .for('share');

    if (!session) {
      return null;
    }

    const [issued] = await tx
      .update(passkey_management_authorizations)
      .set({
        state: 'issued',
        token_hash: hashAuthorizationToken(token),
        expires_at: new Date(Date.now() + PASSKEY_MANAGEMENT_AUTHORIZATION_TTL_MS).toISOString(),
      })
      .where(
        and(
          eq(passkey_management_authorizations.id, params.requestId),
          eq(passkey_management_authorizations.kilo_user_id, params.userId),
          eq(passkey_management_authorizations.device_session_id, params.deviceSessionId),
          eq(passkey_management_authorizations.state, 'approved'),
          sql`${passkey_management_authorizations.expires_at} > NOW()`,
          pepperMatchesAccount(params.userId)
        )
      )
      .returning({ operation: passkey_management_authorizations.operation });

    return issued ?? null;
  });

  if (!collected) {
    return null;
  }

  return {
    token,
    operation: collected.operation,
    expiresIn: Math.floor(PASSKEY_MANAGEMENT_AUTHORIZATION_TTL_MS / 1000),
  };
}

export type PasskeyManagementSsoApprovalRequest = {
  userId: string;
  operation: PasskeyManagementOperation;
  /** The organization the approving browser must be signed in through. */
  ssoOrganizationId: string | null;
  /** The account pepper when the request started; account recovery rotates it. */
  webSessionPepper: string | null;
  /** The stored phase, so a page reports an approval that actually happened. */
  state: 'pending' | 'approved' | 'issued';
};

/**
 * Read one SSO management request for the browser half. The request id is
 * public, so this returns what the approval surface needs to name the account
 * and the operation, and nothing that could authorize a change on its own. The
 * stored phase is included so a page can report an approval that happened
 * instead of trusting a query flag.
 */
export async function readPasskeyManagementSsoRequestForApproval(
  requestId: string
): Promise<PasskeyManagementSsoApprovalRequest | null> {
  const [row] = await db
    .select({
      userId: passkey_management_authorizations.kilo_user_id,
      operation: passkey_management_authorizations.operation,
      ssoOrganizationId: passkey_management_authorizations.sso_organization_id,
      webSessionPepper: passkey_management_authorizations.web_session_pepper,
      state: passkey_management_authorizations.state,
    })
    .from(passkey_management_authorizations)
    .where(
      and(
        eq(passkey_management_authorizations.id, requestId),
        sql`${passkey_management_authorizations.expires_at} > NOW()`
      )
    )
    .limit(1);

  return row ?? null;
}

/**
 * Read whether a live device session owned by this account may manage its
 * passkeys. This reads the primary, not a replica: a revocation written by
 * another instance must refuse the very next management step. A request
 * without a device session, such as an ordinary API key, has no session to
 * read and is refused by the caller.
 */
export async function hasActiveNativeDeviceSession(params: {
  deviceSessionId: string;
  userId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: device_sessions.id })
    .from(device_sessions)
    .where(
      liveDeviceSessionCondition({
        deviceSessionId: params.deviceSessionId,
        userId: params.userId,
      })
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Bind the enrollment options challenge to its grant. The challenge is minted
 * by the options step, and the verify step must present the same pair, so a
 * challenge cannot be verified against a different grant.
 */
export async function bindPasskeyManagementChallenge(params: {
  token: string;
  userId: string;
  deviceSessionId: string;
  challengeId: string;
}): Promise<boolean> {
  const bound = await db
    .update(passkey_management_authorizations)
    .set({ passkey_challenge_id: params.challengeId })
    .where(
      authorizationMatches({
        tokenHash: hashAuthorizationToken(params.token),
        userId: params.userId,
        deviceSessionId: params.deviceSessionId,
        operation: 'enroll',
      })
    )
    .returning({ id: passkey_management_authorizations.id });

  return bound.length > 0;
}

export type PasskeyManagementAuthorizationCheck = {
  token: string;
  userId: string;
  deviceSessionId: string;
  operation: PasskeyManagementOperation;
  /** Required for enrollment: the challenge the options step minted. */
  challengeId?: string;
};

/**
 * Read-only check. The enrollment options step uses it so a grant can be
 * retried after a cancelled ceremony; it consumes nothing.
 */
export async function validatePasskeyManagementAuthorization(
  params: PasskeyManagementAuthorizationCheck
): Promise<boolean> {
  const [row] = await db
    .select({ id: passkey_management_authorizations.id })
    .from(passkey_management_authorizations)
    .where(
      authorizationMatches({
        tokenHash: hashAuthorizationToken(params.token),
        userId: params.userId,
        deviceSessionId: params.deviceSessionId,
        operation: params.operation,
        challengeId: params.challengeId,
      })
    )
    .limit(1);

  return row !== undefined;
}

/**
 * Redeem the grant exactly once. The consuming write is atomic: concurrent
 * callers race on `consumed_at IS NULL`, so one succeeds and every replay
 * matches no row. It runs inside the caller's transaction when one is given,
 * so a mutation that rolls back leaves the grant unspent.
 *
 * The session is read `FOR SHARE` first. Under the caller's transaction that
 * read holds the session row until the change commits, so a concurrent
 * revocation either commits before this redemption (the read then sees
 * `revoked_at` and refuses) or waits and lands after the enrollment. Without
 * the lock, a revocation could commit between the check and the insert and the
 * enrollment would land on a session that no longer exists.
 */
export async function consumePasskeyManagementAuthorization(
  params: PasskeyManagementAuthorizationCheck & { fromDb?: DrizzleConnection }
): Promise<boolean> {
  const executor = params.fromDb ?? db;

  const [session] = await executor
    .select({ id: device_sessions.id })
    .from(device_sessions)
    .where(
      liveDeviceSessionCondition({
        deviceSessionId: params.deviceSessionId,
        userId: params.userId,
      })
    )
    .limit(1)
    .for('share');

  if (!session) {
    return false;
  }

  const consumed = await executor
    .update(passkey_management_authorizations)
    .set({ consumed_at: sql`NOW()` })
    .where(
      authorizationMatches({
        tokenHash: hashAuthorizationToken(params.token),
        userId: params.userId,
        deviceSessionId: params.deviceSessionId,
        operation: params.operation,
        challengeId: params.challengeId,
      })
    )
    .returning({ id: passkey_management_authorizations.id });

  return consumed.length > 0;
}

/** Grants that can no longer authorize anything, for the passkey cron. */
export async function deleteExpiredPasskeyManagementAuthorizations(
  cutoff: string
): Promise<number> {
  const deleted = await db
    .delete(passkey_management_authorizations)
    .where(lt(passkey_management_authorizations.expires_at, cutoff))
    .returning({ id: passkey_management_authorizations.id });
  return deleted.length;
}
