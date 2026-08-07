import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { slack_oauth_credentials, type SlackOAuthCredential } from '@kilocode/db/schema';
import {
  buildSlackCredentialLockKey,
  type SlackCredentialOwner,
} from '@kilocode/worker-utils/slack-credential';
import { db } from '@/lib/drizzle';
import {
  decryptSlackCredentialSecret,
  encryptSlackCredentialSecret,
  type SlackCredentialIdentity,
} from './credential-encryption';

/**
 * System of record for Slack bot credentials.
 *
 * Nothing in production reads this store yet — Step 2 only dual-writes it alongside
 * the existing plaintext `platform_integrations.metadata.access_token`, so the change
 * is reversible. Step 3 repoints the read paths here and deletes the plaintext copy.
 */

export type WriteSlackCredentialInput = {
  integrationId: string;
  slackTeamId: string;
  owner: SlackCredentialOwner;
  botToken: string;
  botUserId?: string | null;
  slackEnterpriseId?: string | null;
  isEnterpriseInstall?: boolean;
  /**
   * Scopes Slack actually granted. Currently unavailable on the install path — the
   * Chat SDK adapter returns only `{ botToken, botUserId, teamName }` and discards
   * the raw `oauth.v2.access` response — so this is left null rather than being
   * filled with the scopes we merely requested. Populating it is what will let
   * `getMissingSlackScopes` detect a real gap.
   */
  grantedScopes?: string[] | null;
  /** Populated from `expires_in` once Slack token rotation is enabled. */
  accessTokenExpiresAt?: string | null;
  /** Present only once Slack token rotation is enabled. */
  refreshToken?: string | null;
};

export type SlackCredentialWriteOutcome =
  | { status: 'written'; credential: SlackOAuthCredential }
  | { status: 'skipped_existing' };

/**
 * Creates or replaces the credential row for an integration.
 *
 * Always re-encrypts under a bumped `credential_version`, because the version is part
 * of the encryption AAD: writing new ciphertext at the old version would leave the
 * previous ciphertext replayable. A transaction-scoped advisory lock serializes
 * concurrent writes for the same integration so two simultaneous installs cannot
 * interleave a read of the current version with a write of the next one.
 */
export async function writeSlackCredential(
  input: WriteSlackCredentialInput
): Promise<SlackOAuthCredential> {
  const outcome = await upsertSlackCredential(input, { onlyIfAbsent: false });
  if (outcome.status === 'skipped_existing') {
    // Unreachable: only `onlyIfAbsent` can skip. Asserted rather than cast so a future
    // change to the skip conditions cannot silently drop a credential write.
    throw new Error('Slack credential write was skipped unexpectedly');
  }
  return outcome.credential;
}

/**
 * Creates the credential row only when the integration does not have one yet.
 *
 * For callers whose token comes from a snapshot rather than from a live Slack
 * response — the Step 2 backfill reads `platform_integrations.metadata` up front — a
 * reinstall part-way through the run writes a fresh credential that a blind replace
 * would overwrite with the by-then-revoked snapshot token. Existence is therefore
 * re-checked inside the same locked transaction as the write.
 */
export async function createSlackCredentialIfAbsent(
  input: WriteSlackCredentialInput
): Promise<SlackCredentialWriteOutcome> {
  return upsertSlackCredential(input, { onlyIfAbsent: true });
}

async function upsertSlackCredential(
  input: WriteSlackCredentialInput,
  { onlyIfAbsent }: { onlyIfAbsent: boolean }
): Promise<SlackCredentialWriteOutcome> {
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${buildSlackCredentialLockKey(input.integrationId)}, 0))`
    );

    const [existing] = await tx
      .select()
      .from(slack_oauth_credentials)
      .where(eq(slack_oauth_credentials.platform_integration_id, input.integrationId))
      .limit(1)
      .for('update');

    if (existing && onlyIfAbsent) return { status: 'skipped_existing' };

    const credentialId = existing?.id ?? randomUUID();
    const credentialVersion = (existing?.credential_version ?? 0) + 1;
    const identity: SlackCredentialIdentity = {
      credentialId,
      integrationId: input.integrationId,
      slackTeamId: input.slackTeamId,
      owner: input.owner,
      credentialVersion,
    };

    const values = {
      slack_team_id: input.slackTeamId,
      slack_enterprise_id: input.slackEnterpriseId ?? null,
      is_enterprise_install: input.isEnterpriseInstall ?? false,
      bot_user_id: input.botUserId ?? null,
      access_token_encrypted: encryptSlackCredentialSecret(input.botToken, identity, 'access'),
      access_token_expires_at: input.accessTokenExpiresAt ?? null,
      refresh_token_encrypted: input.refreshToken
        ? encryptSlackCredentialSecret(input.refreshToken, identity, 'refresh')
        : null,
      granted_scopes: input.grantedScopes ?? null,
      credential_version: credentialVersion,
      // A replaced credential starts a fresh refresh lifecycle.
      refresh_claimed_at: null,
      refresh_attempt_count: 0,
      next_refresh_attempt_at: null,
      last_refreshed_at: null,
      revoked_at: null,
      revocation_reason: null,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const [updated] = await tx
        .update(slack_oauth_credentials)
        .set(values)
        .where(
          and(
            eq(slack_oauth_credentials.id, existing.id),
            eq(slack_oauth_credentials.credential_version, existing.credential_version)
          )
        )
        .returning();
      if (!updated) {
        throw new Error('Slack credential was modified concurrently');
      }
      return { status: 'written', credential: updated };
    }

    const [created] = await tx
      .insert(slack_oauth_credentials)
      .values({ id: credentialId, platform_integration_id: input.integrationId, ...values })
      .returning();
    return { status: 'written', credential: created };
  });
}

export async function getSlackCredentialByIntegrationId(
  integrationId: string
): Promise<SlackOAuthCredential | null> {
  const [row] = await db
    .select()
    .from(slack_oauth_credentials)
    .where(eq(slack_oauth_credentials.platform_integration_id, integrationId))
    .limit(1);

  return row ?? null;
}

/**
 * Decrypts the bot token from a credential row.
 *
 * Returns null for a revoked row so callers cannot accidentally use a credential we
 * have already given up on. Throws `SlackCredentialDecryptionError` when the row
 * exists but cannot be read, which must not be conflated with "no credential".
 */
export function decryptSlackBotToken(
  credential: SlackOAuthCredential,
  owner: SlackCredentialOwner
): string | null {
  if (credential.revoked_at) return null;

  return decryptSlackCredentialSecret(
    credential.access_token_encrypted,
    {
      credentialId: credential.id,
      integrationId: credential.platform_integration_id,
      slackTeamId: credential.slack_team_id,
      owner,
      credentialVersion: credential.credential_version,
    },
    'access'
  );
}
