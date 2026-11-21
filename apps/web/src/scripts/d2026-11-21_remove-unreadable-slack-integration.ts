/**
 * Offline maintenance command: deletes one Slack integration row and its stored
 * credential by integration id.
 *
 * Usage, dry run first then --execute:
 *   pnpm --filter web script src/scripts/d2026-11-21_remove-unreadable-slack-integration.ts \
 *     --integration-id=<uuid>
 *   pnpm --filter web script src/scripts/d2026-11-21_remove-unreadable-slack-integration.ts \
 *     --integration-id=<uuid> --execute
 *
 * Requires SLACK_CREDENTIAL_KEYSET_JSON and POSTGRES_SCRIPT_URL. Prints no credential
 * material: no token, ciphertext, key id, or key data.
 */

import '../lib/load-env';

import { and, eq } from 'drizzle-orm';
import { db, closeAllDrizzleConnections } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import type { SlackCredentialOwner } from '@kilocode/worker-utils/slack-credential';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  SlackCredentialKeysetError,
  isSlackCredentialEncryptionConfigured,
} from '@/lib/integrations/platforms/slack/credential-keyset';
import { SlackCredentialDecryptionError } from '@/lib/integrations/platforms/slack/credential-encryption';
import {
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
} from '@/lib/integrations/platforms/slack/credential-store';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `remove` is the only outcome that deletes a row; every other outcome names its skip code. */
type Decision = { action: 'remove' } | { action: 'skip'; code: SkipCode };

type SkipCode =
  | 'not_found'
  | 'no_owner'
  | 'no_stored_credential'
  | 'stored_credential_usable'
  | 'stored_credential_revoked';

function parseArgs(): { integrationId: string; execute: boolean } {
  let integrationId: string | null = null;
  let execute = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg.startsWith('--integration-id=')) {
      integrationId = arg.slice('--integration-id='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!integrationId) {
    throw new Error('Missing required argument: --integration-id=<uuid>');
  }
  if (!UUID_PATTERN.test(integrationId)) {
    throw new Error(`Invalid --integration-id, expected a UUID: ${integrationId}`);
  }

  return { integrationId, execute };
}

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

async function decide(integrationId: string, owner: SlackCredentialOwner): Promise<Decision> {
  const credential = await getSlackCredentialByIntegrationId(integrationId);
  if (!credential) return { action: 'skip', code: 'no_stored_credential' };

  try {
    const token = decryptSlackBotToken(credential, owner);
    return {
      action: 'skip',
      code: token === null ? 'stored_credential_revoked' : 'stored_credential_usable',
    };
  } catch (error) {
    // A keyset problem is not evidence about this one credential: it fails every row the
    // same way, so it must never reach the removal branch. The decryption error wraps the
    // keyset error as its cause, which is why the check reads the cause too.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof SlackCredentialKeysetError) throw cause;
    if (error instanceof SlackCredentialKeysetError) throw error;
    if (error instanceof SlackCredentialDecryptionError) return { action: 'remove' };
    throw error;
  }
}

async function main(): Promise<void> {
  const { integrationId, execute } = parseArgs();

  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);

  // Fail before touching a row: with no usable keyset every credential is undecryptable,
  // so the eligibility check below cannot tell a broken key from a stale ciphertext.
  if (!isSlackCredentialEncryptionConfigured()) {
    console.error('Refused: keyset_not_configured');
    process.exitCode = 1;
    return;
  }

  const [integration] = await db
    .select({
      id: platform_integrations.id,
      platform: platform_integrations.platform,
      owned_by_user_id: platform_integrations.owned_by_user_id,
      owned_by_organization_id: platform_integrations.owned_by_organization_id,
      platform_installation_id: platform_integrations.platform_installation_id,
      platform_account_id: platform_integrations.platform_account_id,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.SLACK)
      )
    )
    .limit(1);

  if (!integration) {
    console.error(`Skipped: not_found (${integrationId})`);
    process.exitCode = 1;
    return;
  }

  const owner = readOwner(integration);
  const workspaceId =
    integration.platform_installation_id ?? integration.platform_account_id ?? '(none)';

  const decision = owner
    ? await decide(integrationId, owner)
    : ({ action: 'skip', code: 'no_owner' } as const);

  console.log('\n--- Integration ---');
  console.log(`Integration id:  ${integration.id}`);
  console.log(`Platform:        ${integration.platform}`);
  console.log(`Workspace id:    ${workspaceId}`);
  console.log(`Owner type:      ${owner ? owner.type : '(none)'}`);
  console.log(`Owner id:        ${owner ? owner.id : '(none)'}`);

  console.log('\n--- Decision ---');
  if (decision.action === 'skip') {
    console.log(`Skipped: ${decision.code}`);
    console.log('Nothing deleted.');
    process.exitCode = 1;
    return;
  }

  console.log('Action: remove');

  if (!execute) {
    console.log('Dry run: nothing deleted');
    return;
  }

  const deleted = await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.SLACK)
      )
    )
    .returning({ id: platform_integrations.id });

  console.log(`Deleted rows: ${deleted.length}`);

  if (deleted.length === 1) return;

  console.error(`Expected to delete exactly one row, deleted ${deleted.length}.`);
  process.exitCode = 1;
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
