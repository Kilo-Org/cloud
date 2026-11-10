import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { user_github_app_tokens } from '@kilocode/db/schema';
import {
  lockGitHubGrant,
  lockGitHubIdentity,
  type GitHubIdentityPrecondition,
} from '@kilocode/db/github-identity';
import { evictGitHubUserAccessTokenCache } from './user-token-client';

export async function storeGitHubIdentity(
  values: typeof user_github_app_tokens.$inferInsert,
  expected: GitHubIdentityPrecondition,
  verifyCredential?: () => Promise<void>
) {
  const stored = await db.transaction(async tx => {
    const existing = await lockGitHubIdentity(tx, values.kilo_user_id, expected);
    await lockGitHubGrant(tx, values.github_user_id);
    const [owner] = await tx
      .select({ kiloUserId: user_github_app_tokens.kilo_user_id })
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.github_user_id, values.github_user_id),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    if (owner && owner.kiloUserId !== values.kilo_user_id) {
      return { status: 'already_connected_to_another_account' } as const;
    }
    if (existing && existing.github_user_id !== values.github_user_id) {
      return { status: 'disconnect_existing_identity_first' } as const;
    }
    // Refresh uses the grant lock. Recheck the generation after acquiring it.
    const current = await lockGitHubIdentity(tx, values.kilo_user_id, expected);
    await verifyCredential?.();
    const replacement = {
      ...values,
      revoked_at: null,
      revocation_reason: null,
      credential_version: sql`${user_github_app_tokens.credential_version} + 1`,
      updated_at: new Date().toISOString(),
    };
    const [authorization] = current
      ? await tx
          .update(user_github_app_tokens)
          .set(replacement)
          .where(eq(user_github_app_tokens.id, current.id))
          .returning()
      : await tx.insert(user_github_app_tokens).values(values).returning();
    return {
      status: 'connected',
      githubLogin: authorization.github_login,
      credentialSource: authorization.credential_source,
      expiresAt: authorization.access_token_expires_at
        ? new Date(authorization.access_token_expires_at).toISOString()
        : null,
      authorizationId: authorization.id,
      credentialVersion: authorization.credential_version,
    } as const;
  });
  if (stored.status === 'connected') evictGitHubUserAccessTokenCache(values.kilo_user_id);
  return stored;
}

/**
 * The GitHub account bound to this Kilo account's standard identity slot, or
 * `null` when the account never authorized one. GitHub verified the login when
 * it was stored, so it names the person; whether that account still holds a
 * credential here does not change which account it is.
 */
export async function getLinkedGitHubLogin(kiloUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ githubLogin: user_github_app_tokens.github_login })
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.kilo_user_id, kiloUserId),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .limit(1);
  return row?.githubLogin ?? null;
}
