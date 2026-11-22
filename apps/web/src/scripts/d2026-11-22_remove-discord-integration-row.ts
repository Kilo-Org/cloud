/**
 * Offline maintenance command: removes one Discord integration row by its integration id.
 *
 * Usage, dry run first then --execute:
 *   pnpm --filter web script src/scripts/d2026-11-22_remove-discord-integration-row.ts \
 *     --integration-id=<uuid>
 *   pnpm --filter web script src/scripts/d2026-11-22_remove-discord-integration-row.ts \
 *     --integration-id=<uuid> --execute
 *
 * Operator sequence: remove the Kilo bot from the Discord server printed below in the Discord
 * client, then run this command for that row.
 *
 * Removes the local row only; it makes no Discord request.
 *
 * Requires POSTGRES_SCRIPT_URL for the connection, and POSTGRES_URL because the shared client
 * resolves that variable before it selects the script connection. Prints no credential
 * material: this table stores no Discord token, and the command prints no token, credential,
 * or secret of any kind.
 */

import '../lib/load-env';

import { and, eq } from 'drizzle-orm';
import { db, closeAllDrizzleConnections } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { PLATFORM } from '@/lib/integrations/core/constants';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `remove` is the only outcome that deletes a row; every other outcome names its skip code. */
type Decision = { action: 'remove' } | { action: 'skip'; code: SkipCode };

type SkipCode = 'not_found' | 'no_owner';

function parseArgs(): { integrationId: string; execute: boolean } {
  let integrationId: string | null = null;
  let execute = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg.startsWith('--integration-id=')) {
      // One integration id, so a repeated flag is more likely a mistake than an intent.
      if (integrationId !== null) {
        throw new Error('--integration-id accepts one id and was given more than once');
      }
      const value = arg.slice('--integration-id='.length);
      if (!value) {
        throw new Error(`Invalid --integration-id, expected a UUID: ${arg}`);
      }
      integrationId = value;
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

async function main(): Promise<void> {
  const { integrationId, execute } = parseArgs();

  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);

  const [integration] = await db
    .select({
      id: platform_integrations.id,
      platform: platform_integrations.platform,
      owned_by_user_id: platform_integrations.owned_by_user_id,
      owned_by_organization_id: platform_integrations.owned_by_organization_id,
      platform_installation_id: platform_integrations.platform_installation_id,
      platform_account_id: platform_integrations.platform_account_id,
      integration_status: platform_integrations.integration_status,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.DISCORD)
      )
    )
    .limit(1);

  if (!integration) {
    console.error(`Skipped: not_found (${integrationId})`);
    process.exitCode = 1;
    return;
  }

  const serverId =
    integration.platform_installation_id ?? integration.platform_account_id ?? '(none)';
  const ownerType = integration.owned_by_user_id
    ? 'user'
    : integration.owned_by_organization_id
      ? 'org'
      : '(none)';
  const ownerId = integration.owned_by_user_id ?? integration.owned_by_organization_id ?? '(none)';

  console.log('\n--- Integration ---');
  console.log(`Integration id:  ${integration.id}`);
  console.log(`Platform:        ${integration.platform}`);
  console.log(`Server id:       ${serverId}`);
  console.log(`Owner type:      ${ownerType}`);
  console.log(`Owner id:        ${ownerId}`);
  console.log(`Status:          ${integration.integration_status ?? '(none)'}`);

  // The database enforces exactly one owner, but a row without one cannot be attributed to
  // anybody, so the command refuses it rather than guessing whose connection this was.
  const decision: Decision =
    integration.owned_by_user_id || integration.owned_by_organization_id
      ? { action: 'remove' }
      : { action: 'skip', code: 'no_owner' };

  console.log('\n--- Decision ---');
  if (decision.action === 'skip') {
    console.log(`Skipped: ${decision.code}`);
    console.log('Nothing deleted.');
    process.exitCode = 1;
    return;
  }

  console.log('Action: remove');
  console.log(`Discord server for this row: ${serverId}`);

  if (!execute) {
    console.log('Dry run: nothing deleted');
    return;
  }

  const deleted = await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.DISCORD)
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
