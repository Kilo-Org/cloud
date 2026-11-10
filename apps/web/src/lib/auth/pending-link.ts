import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import * as z from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { passkey_credentials, pending_auth_links, type PendingAuthLink } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { allow_fake_login } from '@kilocode/web-shared/lib/constants';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  getUserAuthProviders,
  linkAccountToExistingUser,
  type CreateOrUpdateUserArgs,
  type DifferentOAuthFailure,
} from '@/lib/user';

const useSecureCookies = NEXTAUTH_URL?.startsWith('https://') ?? false;
export const PENDING_LINK_COOKIE = useSecureCookies
  ? '__Host-pending-auth-link'
  : 'pending-auth-link';
export const PENDING_LINK_TTL_MINUTES = 15;
export const MAX_EMAIL_CODE_SENDS_PER_PENDING_LINK = 3;

export type PendingLinkFailureReason =
  | 'EXPIRED'
  | 'WRONG_ACCOUNT'
  | 'ACCOUNT-ALREADY-LINKED'
  | 'PROVIDER-ALREADY-LINKED'
  | 'LINKING-FAILED';

export type PendingLinkResult =
  | { status: 'linked'; provider: AuthProviderId }
  | { status: 'failed'; reason: PendingLinkFailureReason };

export type PendingLinkSummary = {
  provider: AuthProviderId;
  /** The email address of the identity being attached. */
  email: string;
  displayName: string | null;
  /** The primary address of the account the identity attaches to. */
  accountEmail: string;
  methods: AuthProviderId[];
  emailCode: boolean;
  expiresAt: string;
  kind: PendingAuthLink['kind'];
  callbackPath: string | null;
  kiloUserId: string;
};

const secretSchema = z.string().trim().min(1).max(512);

export function hashPendingLinkSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function parseSecret(secret: unknown): string | null {
  const parsed = secretSchema.safeParse(secret);
  return parsed.success ? parsed.data : null;
}

export async function createPendingLink(params: {
  kiloUserId: string;
  kind: PendingAuthLink['kind'];
  identity: CreateOrUpdateUserArgs;
  emailCodeAllowed: boolean;
  callbackPath?: string | null;
}): Promise<{ secret: string; pendingLink: PendingAuthLink }> {
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PENDING_LINK_TTL_MINUTES * 60 * 1000).toISOString();
  // Rows are single-use and short-lived; drop those expired for a day so the
  // table stays small without a separate job.
  await db
    .delete(pending_auth_links)
    .where(sql`${pending_auth_links.expires_at} < NOW() - INTERVAL '1 day'`);
  const [row] = await db
    .insert(pending_auth_links)
    .values({
      secret_hash: hashPendingLinkSecret(secret),
      kilo_user_id: params.kiloUserId,
      kind: params.kind,
      provider: params.identity.provider,
      provider_account_id: params.identity.provider_account_id,
      email: params.identity.google_user_email,
      avatar_url: params.identity.google_user_image_url,
      display_name: params.identity.display_name ?? null,
      hosted_domain: params.identity.hosted_domain,
      email_code_allowed: params.emailCodeAllowed,
      callback_path: params.callbackPath ?? null,
      expires_at: expiresAt,
    })
    .returning();
  if (!row) throw new Error('Failed to create pending auth link');
  return { secret, pendingLink: row };
}

/**
 * Creates a pending link for an eligible DIFFERENT-OAUTH settlement.
 * Returns null when the account already has that provider type, because the
 * link would fail with PROVIDER-ALREADY-LINKED.
 */
export async function createPendingLinkForDifferentOAuth(
  identity: CreateOrUpdateUserArgs,
  failure: DifferentOAuthFailure,
  callbackPath?: string | null
): Promise<{ secret: string; pendingLink: PendingAuthLink } | null> {
  if (failure.providerAlreadyPresent) return null;
  return createPendingLink({
    kiloUserId: failure.targetUserId,
    kind: 'existing_account',
    identity,
    emailCodeAllowed: failure.accountHasVerifiedPrimaryAddress,
    callbackPath: callbackPath ?? null,
  });
}

async function findByHash(secretHash: string): Promise<PendingAuthLink | null> {
  const [row] = await db
    .select()
    .from(pending_auth_links)
    .where(eq(pending_auth_links.secret_hash, secretHash))
    .limit(1);
  return row ?? null;
}

function isLive(row: PendingAuthLink): boolean {
  return row.consumed_at === null && new Date(row.expires_at).getTime() > Date.now();
}

export async function getPendingLinkBySecret(secret: unknown): Promise<PendingAuthLink | null> {
  const parsed = parseSecret(secret);
  if (!parsed) return null;
  return getLivePendingLinkByHash(hashPendingLinkSecret(parsed));
}

export async function getLivePendingLinkByHash(
  secretHash: string
): Promise<PendingAuthLink | null> {
  const row = await findByHash(secretHash);
  return row && isLive(row) ? row : null;
}

/** Whether the secret still names a live row, re-read at call time. */
export async function isPendingLinkLive(secret: unknown): Promise<boolean> {
  return (await getPendingLinkBySecret(secret)) !== null;
}

export async function getPendingLinkMethods(
  kiloUserId: string,
  pendingProvider: AuthProviderId
): Promise<AuthProviderId[]> {
  const providers = await getUserAuthProviders(kiloUserId);
  const methods = new Set<AuthProviderId>();
  for (const row of providers) {
    if (row.provider === 'workos') continue;
    if (row.provider === 'fake-login' && !allow_fake_login) continue;
    if (row.provider === pendingProvider) continue;
    methods.add(row.provider);
  }
  const [passkey] = await db
    .select({ id: passkey_credentials.id })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, kiloUserId))
    .limit(1);
  if (passkey && pendingProvider !== 'passkey') methods.add('passkey');
  return [...methods];
}

export function pendingLinkIdentity(row: PendingAuthLink): CreateOrUpdateUserArgs {
  return {
    google_user_email: row.email,
    google_user_name: row.display_name || row.email.split('@')[0],
    google_user_image_url: row.avatar_url,
    hosted_domain: row.hosted_domain,
    provider: row.provider,
    provider_account_id: row.provider_account_id,
    display_name: row.display_name,
  };
}

export async function summarizePendingLink(row: PendingAuthLink): Promise<PendingLinkSummary> {
  const account = await findUserById(row.kilo_user_id);
  return {
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    accountEmail: account?.google_user_email ?? row.email,
    methods: await getPendingLinkMethods(row.kilo_user_id, row.provider),
    emailCode: row.email_code_allowed,
    expiresAt: new Date(row.expires_at).toISOString(),
    kind: row.kind,
    callbackPath: row.callback_path,
    kiloUserId: row.kilo_user_id,
  };
}

export async function setPendingLinkEmailChallenge(
  secret: string,
  challengeId: string
): Promise<void> {
  await db
    .update(pending_auth_links)
    .set({ email_code_challenge_id: challengeId })
    .where(eq(pending_auth_links.secret_hash, hashPendingLinkSecret(secret)));
}

/**
 * Atomically spends one of this row's email-code sends. Returns false when
 * the row is gone, no longer live, or already at the send cap.
 */
export async function claimEmailCodeSend(secret: string): Promise<boolean> {
  const [claimed] = await db
    .update(pending_auth_links)
    .set({ email_code_send_count: sql`${pending_auth_links.email_code_send_count} + 1` })
    .where(
      and(
        eq(pending_auth_links.secret_hash, hashPendingLinkSecret(secret)),
        isNull(pending_auth_links.consumed_at),
        sql`${pending_auth_links.expires_at} > NOW()`,
        sql`${pending_auth_links.email_code_send_count} < ${MAX_EMAIL_CODE_SENDS_PER_PENDING_LINK}`
      )
    )
    .returning({ id: pending_auth_links.id });
  return Boolean(claimed);
}

/** Returns a claimed send whose email never went out. */
export async function releaseEmailCodeSend(secret: string): Promise<void> {
  await db
    .update(pending_auth_links)
    .set({
      email_code_send_count: sql`GREATEST(${pending_auth_links.email_code_send_count} - 1, 0)`,
    })
    .where(eq(pending_auth_links.secret_hash, hashPendingLinkSecret(secret)));
}

export async function completePendingLink(
  secret: unknown,
  resolvedUserId: string
): Promise<PendingLinkResult> {
  const parsed = parseSecret(secret);
  if (!parsed) return { status: 'failed', reason: 'EXPIRED' };
  return completePendingLinkByHash(hashPendingLinkSecret(parsed), resolvedUserId);
}

export async function completePendingLinkByHash(
  secretHash: string,
  resolvedUserId: string
): Promise<PendingLinkResult> {
  const row = await findByHash(secretHash);
  if (!row || !isLive(row)) return { status: 'failed', reason: 'EXPIRED' };
  if (resolvedUserId !== row.kilo_user_id) return { status: 'failed', reason: 'WRONG_ACCOUNT' };

  const [claimed] = await db
    .update(pending_auth_links)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(pending_auth_links.id, row.id),
        isNull(pending_auth_links.consumed_at),
        sql`${pending_auth_links.expires_at} > NOW()`
      )
    )
    .returning();
  if (!claimed) return { status: 'failed', reason: 'EXPIRED' };

  const restoreClaim = async () => {
    await db
      .update(pending_auth_links)
      .set({ consumed_at: null })
      .where(and(eq(pending_auth_links.id, row.id), sql`${pending_auth_links.expires_at} > NOW()`));
  };

  let linkResult: Awaited<ReturnType<typeof linkAccountToExistingUser>>;
  try {
    linkResult = await linkAccountToExistingUser(row.kilo_user_id, pendingLinkIdentity(row));
  } catch (error) {
    await restoreClaim();
    throw error;
  }
  if (!linkResult.success) {
    await restoreClaim();
    const reason: PendingLinkFailureReason =
      linkResult.error === 'ACCOUNT-ALREADY-LINKED' ||
      linkResult.error === 'PROVIDER-ALREADY-LINKED'
        ? linkResult.error
        : 'LINKING-FAILED';
    return { status: 'failed', reason };
  }
  return { status: 'linked', provider: row.provider };
}

/** The mobile 200-body field for a sign-in that carried a pending link token. */
export async function resolvePendingLinkForUser(
  secret: string | undefined,
  resolvedUserId: string
): Promise<PendingLinkResult | undefined> {
  if (!secret) return undefined;
  try {
    return await completePendingLink(secret, resolvedUserId);
  } catch {
    return { status: 'failed', reason: 'LINKING-FAILED' };
  }
}

export async function setPendingLinkCookie(secret: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(PENDING_LINK_COOKIE, secret, {
    httpOnly: true,
    secure: useSecureCookies,
    sameSite: 'lax',
    maxAge: PENDING_LINK_TTL_MINUTES * 60,
    path: '/',
  });
}

export async function readPendingLinkSecret(): Promise<string | null> {
  const cookieStore = await cookies();
  // Only the configured name counts: under HTTPS it is `__Host-` prefixed, so
  // a sibling subdomain cannot plant a secret this route will read.
  return parseSecret(cookieStore.get(PENDING_LINK_COOKIE)?.value);
}

export async function clearPendingLinkCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(PENDING_LINK_COOKIE);
}

export const pendingLinkPageUrl = '/users/pending-link';
export const pendingLinkCompleteUrl = '/api/auth/pending-link/complete';
