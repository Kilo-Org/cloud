import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { user_github_app_tokens } from '@kilocode/db/schema';

import { db } from '@/lib/drizzle';
// Single source of truth for the envelope scheme, active key, and AAD. Reusing
// the production helper guarantees the seeded row stays decryptable by
// git-token-service even if the scheme/AAD ever changes.
import { encryptUserGithubTokenEnvelope } from '@/lib/integrations/platforms/github/user-token-envelope';

// The dev seed writes a far-future expiry so E2E never hits a "token expired"
// branch while the suite is running. YEAR 9999 is the same convention the
// schema fixtures use for non-expiring credentials.
const FAR_FUTURE_ISO = '9999-12-31T23:59:59.000Z';

export type SeedUserGithubTokenResult = {
  upserted: boolean;
  githubLogin: string;
};

/**
 * Dev-only helper. Encrypts the supplied FAKE token with the same public-key
 * envelope the real OAuth callback uses, then upserts a `standard`
 * `user_github_app_tokens` row keyed on `kiloUserId`. The same `token` is
 * used for both access and refresh — a fake token only needs to authenticate
 * against the local mock GitHub server.
 *
 * The single-source-of-truth: this is the path the dev E2E suite relies on to
 * skip the real OAuth round-trip.
 */
export async function seedUserGithubToken(input: {
  kiloUserId: string;
  token: string;
  githubLogin: string;
  githubUserId: string;
}): Promise<SeedUserGithubTokenResult> {
  const values = {
    kilo_user_id: input.kiloUserId,
    github_app_type: 'standard' as const,
    github_user_id: input.githubUserId,
    github_login: input.githubLogin,
    access_token_encrypted: encryptUserGithubTokenEnvelope(input.token, {
      kiloUserId: input.kiloUserId,
      githubUserId: input.githubUserId,
      tokenType: 'access',
    }),
    access_token_expires_at: FAR_FUTURE_ISO,
    refresh_token_encrypted: encryptUserGithubTokenEnvelope(input.token, {
      kiloUserId: input.kiloUserId,
      githubUserId: input.githubUserId,
      tokenType: 'refresh',
    }),
    refresh_token_expires_at: FAR_FUTURE_ISO,
    revoked_at: null,
    revocation_reason: null,
  };

  const [stored] = await db
    .insert(user_github_app_tokens)
    .values(values)
    .onConflictDoUpdate({
      target: [user_github_app_tokens.kilo_user_id, user_github_app_tokens.github_app_type],
      set: {
        github_user_id: values.github_user_id,
        github_login: values.github_login,
        access_token_encrypted: values.access_token_encrypted,
        access_token_expires_at: values.access_token_expires_at,
        refresh_token_encrypted: values.refresh_token_encrypted,
        refresh_token_expires_at: values.refresh_token_expires_at,
        revoked_at: null,
        revocation_reason: null,
        credential_version: sql`${user_github_app_tokens.credential_version} + 1`,
        updated_at: new Date().toISOString(),
      },
      setWhere: eq(user_github_app_tokens.github_user_id, input.githubUserId),
    })
    .returning({ id: user_github_app_tokens.id });

  return {
    upserted: Boolean(stored?.id),
    githubLogin: input.githubLogin,
  };
}
