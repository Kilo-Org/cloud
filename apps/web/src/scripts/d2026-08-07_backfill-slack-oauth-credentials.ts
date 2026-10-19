/**
 * Backfills existing Slack bot tokens from
 * `platform_integrations.metadata` into the encrypted
 * `slack_oauth_credentials` store, then removes the plaintext token from
 * metadata.
 *
 * The copy pass is idempotent: integrations that already have a credential row are
 * skipped rather than re-encrypted, so re-running does not churn `credential_version`
 * (each bump invalidates the previous ciphertext, since the version is inside the
 * AAD). The skip is enforced by the write itself, so a reinstall that lands mid-run
 * keeps its fresh token instead of being overwritten by this run's older metadata
 * snapshot.
 *
 * The scrub pass (on by default with --execute; opt out with --no-scrub) deletes
 * `metadata.access_token` for every Slack integration that has a credential row,
 * preserving all other metadata keys. Rows without a credential row keep their
 * plaintext token and are reported, so the operation is safe to re-run after fixing
 * them. Run this only after the cutover that reads tokens from the credential store
 * is deployed.
 *
 * Requires SLACK_CREDENTIAL_KEYSET_JSON. Never prints token material.
 *
 * Usage:
 *   pnpm --filter web script src/scripts/d2026-08-07_backfill-slack-oauth-credentials.ts
 *   pnpm --filter web script src/scripts/d2026-08-07_backfill-slack-oauth-credentials.ts --execute
 *   pnpm --filter web script src/scripts/d2026-08-07_backfill-slack-oauth-credentials.ts --execute --no-scrub
 */

import '../lib/load-env';

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, closeAllDrizzleConnections } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations, slack_oauth_credentials } from '@kilocode/db/schema';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { SlackCredentialOwner } from '@kilocode/worker-utils/slack-credential';
import {
  createSlackCredentialIfAbsent,
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
} from '@/lib/integrations/platforms/slack/credential-store';
import { requireSlackCredentialKeyset } from '@/lib/integrations/platforms/slack/credential-keyset';

type SkipReason =
  | 'already_migrated'
  | 'no_plaintext_token'
  | 'no_owner'
  | 'no_team_id'
  | 'write_failed'
  | 'scrub_no_credential'
  | 'scrub_failed';

function parseArgs(): { execute: boolean; scrub: boolean; batchSize: number } {
  let execute = false;
  let scrub = true;
  let batchSize = 200;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--no-scrub') {
      scrub = false;
    } else if (arg.startsWith('--batch-size=')) {
      const parsed = Number(arg.slice('--batch-size='.length));
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --batch-size: ${arg}`);
      }
      batchSize = parsed;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { execute, scrub, batchSize };
}

function readPlaintextToken(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  if (!('access_token' in metadata)) return null;
  const value = metadata.access_token;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function main(): Promise<void> {
  const { execute, scrub, batchSize } = parseArgs();

  // Fail fast rather than discovering a bad keyset partway through a run.
  const { active } = requireSlackCredentialKeyset();
  console.log(`Encryption key ID: ${active.keyId}`);
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);

  const integrations = await db
    .select({
      id: platform_integrations.id,
      owned_by_user_id: platform_integrations.owned_by_user_id,
      owned_by_organization_id: platform_integrations.owned_by_organization_id,
      platform_installation_id: platform_integrations.platform_installation_id,
      platform_account_id: platform_integrations.platform_account_id,
      metadata: platform_integrations.metadata,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        isNotNull(platform_integrations.metadata)
      )
    )
    .orderBy(platform_integrations.id);

  console.log(`Slack integrations found: ${integrations.length}`);

  const skipped: Record<SkipReason, number> = {
    already_migrated: 0,
    no_plaintext_token: 0,
    no_owner: 0,
    no_team_id: 0,
    write_failed: 0,
    scrub_no_credential: 0,
    scrub_failed: 0,
  };
  let migrated = 0;
  let eligible = 0;
  let scrubbed = 0;
  // Integrations whose credential row this run can vouch for: either the row was
  // written by this run, or it decrypts to the metadata token (checked below).
  // Only these are eligible for the scrub pass.
  const scrubCandidateIds = new Set<string>();

  for (let offset = 0; offset < integrations.length; offset += batchSize) {
    const batch = integrations.slice(offset, offset + batchSize);

    // Cheap pre-filter only: it avoids opening a transaction per already-migrated
    // integration. `createSlackCredentialIfAbsent` is what actually guarantees we never
    // replace a row, since this snapshot can go stale before the write.
    const existingRows = await db
      .select({ integrationId: slack_oauth_credentials.platform_integration_id })
      .from(slack_oauth_credentials)
      .where(
        inArray(
          slack_oauth_credentials.platform_integration_id,
          batch.map(integration => integration.id)
        )
      );
    const alreadyMigrated = new Set(existingRows.map(row => row.integrationId));

    for (const integration of batch) {
      if (alreadyMigrated.has(integration.id)) {
        skipped.already_migrated += 1;
        // The metadata token and the stored credential must agree before the
        // metadata copy is removed. The comparison below admits the row for
        // scrubbing only on an exact match; any other result keeps it unchanged.
        if (execute && scrub) {
          const fresh = await storedCredentialMatches(integration.id, integration);
          if (fresh === true) {
            scrubCandidateIds.add(integration.id);
          } else if (fresh === false) {
            skipped.scrub_no_credential += 1;
          } else {
            skipped.scrub_failed += 1;
          }
        }
        continue;
      }

      const botToken = readPlaintextToken(integration.metadata);
      if (!botToken) {
        skipped.no_plaintext_token += 1;
        continue;
      }

      const owner = readOwner(integration);
      if (!owner) {
        skipped.no_owner += 1;
        console.warn(`No owner for integration ${integration.id}`);
        continue;
      }

      const teamId = integration.platform_installation_id ?? integration.platform_account_id;
      if (!teamId) {
        skipped.no_team_id += 1;
        console.warn(`No Slack team ID for integration ${integration.id}`);
        continue;
      }

      eligible += 1;

      if (!execute) continue;

      try {
        const outcome = await createSlackCredentialIfAbsent({
          integrationId: integration.id,
          slackTeamId: teamId,
          owner,
          botToken,
          botUserId: readBotUserId(integration.metadata),
        });
        if (outcome.status === 'skipped_existing') {
          skipped.already_migrated += 1;
        } else {
          migrated += 1;
          scrubCandidateIds.add(integration.id);
        }
      } catch (error) {
        skipped.write_failed += 1;
        // Message only: the stack of an encryption failure can carry key material.
        console.error(
          `Failed integration ${integration.id}: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }
  }

  // Scrub pass: remove the metadata token for every eligible integration.
  // - A row is eligible only when its stored credential is current: the credential
  //   was written by this run's copy pass, or an existing credential decrypts to
  //   exactly the metadata token. Every other row is reported and left unchanged so
  //   the script can be repeated after it is resolved.
  // The metadata update removes only the token key (`jsonb -`), so concurrent writes
  // to other metadata fields between the snapshot above and this update survive.
  if (execute && scrub) {
    for (const integration of integrations) {
      if (!scrubCandidateIds.has(integration.id)) continue;
      const metadata = integration.metadata;
      if (metadata === null || typeof metadata !== 'object') continue;
      if (!('access_token' in metadata)) continue;

      try {
        await db
          .update(platform_integrations)
          .set({
            metadata: sql`${platform_integrations.metadata} - 'access_token'`,
            updated_at: new Date().toISOString(),
          })
          .where(eq(platform_integrations.id, integration.id));
        scrubbed += 1;
      } catch (error) {
        skipped.scrub_failed += 1;
        console.error(
          `Failed to scrub integration ${integration.id}: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(slack_oauth_credentials);

  console.log('\n--- Summary ---');
  console.log(`Eligible for backfill:       ${eligible}`);
  console.log(`Migrated:                    ${migrated}`);
  console.log(`Scrubbed plaintext tokens:   ${scrubbed}`);
  console.log(`Kept (no credential row):    ${skipped.scrub_no_credential}`);
  console.log(`Failed scrubs:               ${skipped.scrub_failed}`);
  console.log(`Skipped (already migrated):  ${skipped.already_migrated}`);
  console.log(`Skipped (no plaintext):      ${skipped.no_plaintext_token}`);
  console.log(`Skipped (no owner):          ${skipped.no_owner}`);
  console.log(`Skipped (no team ID):        ${skipped.no_team_id}`);
  console.log(`Failed writes:               ${skipped.write_failed}`);
  console.log(`slack_oauth_credentials rows: ${total}`);
  console.log(`Mode:                        ${execute ? 'EXECUTED' : 'DRY RUN'}`);
}

/**
 * The owner is part of the encryption AAD, so it must be the exclusive owner recorded
 * on the integration. `platform_integrations_owner_check` guarantees exactly one is
 * set; anything else is corrupt data and is skipped rather than guessed at.
 */
function readOwner(integration: {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
}): SlackCredentialOwner | null {
  if (integration.owned_by_organization_id && !integration.owned_by_user_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id && !integration.owned_by_organization_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

function readBotUserId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  if (!('bot_user_id' in metadata)) return null;
  const value = metadata.bot_user_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether the integration's stored credential is exactly its current metadata token.
 *
 * Returns true on an exact match, false when the credential row is absent, revoked,
 * or the integration has no exclusive owner, and null when the row could not be
 * read. The caller reports the distinction so each outcome gets the right follow-up.
 * Never logs or prints token material.
 */
async function storedCredentialMatches(
  integrationId: string,
  integration: {
    owned_by_organization_id: string | null;
    owned_by_user_id: string | null;
    metadata: unknown;
  }
): Promise<boolean | null> {
  const botToken = readPlaintextToken(integration.metadata);
  if (!botToken) return false;
  const owner = readOwner(integration);
  if (!owner) return false;

  const credential = await getSlackCredentialByIntegrationId(integrationId);
  if (!credential) return false;

  try {
    return decryptSlackBotToken(credential, owner) === botToken;
  } catch {
    return null;
  }
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
