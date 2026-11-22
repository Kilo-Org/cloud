/**
 * Offline maintenance command: removes one Discord integration row by its integration id.
 *
 * Usage, dry run first then --execute:
 *   pnpm --filter web script src/scripts/d2026-11-22_remove-discord-integration-row.ts \
 *     --integration-id=<uuid>
 *   pnpm --filter web script src/scripts/d2026-11-22_remove-discord-integration-row.ts \
 *     --integration-id=<uuid> --execute
 *
 * Operator sequence: run this command for the row first. It reports every other row that
 * records the same server and refuses a shared one. When it reports none, remove the Kilo
 * bot from that server in the Discord client, then run this command again with --execute.
 *
 * The command removes the local row only and makes no Discord request.
 *
 * Requires POSTGRES_SCRIPT_URL for the connection, and POSTGRES_URL because the shared client
 * resolves that variable before it selects the script connection. Prints no credential
 * material: this table stores no Discord token, and the command prints no token, credential,
 * or secret of any kind.
 */

import '../lib/load-env';

import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { db, closeAllDrizzleConnections } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { PLATFORM } from '@/lib/integrations/core/constants';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why the command refuses a row; each code names the state it found. */
type SkipCode = 'not_found' | 'no_owner' | 'no_server' | 'shared_server' | 'changed';

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

  const serverId = integration.platform_installation_id ?? integration.platform_account_id ?? null;
  const ownerType = integration.owned_by_user_id
    ? 'user'
    : integration.owned_by_organization_id
      ? 'org'
      : '(none)';
  const ownerId = integration.owned_by_user_id ?? integration.owned_by_organization_id ?? '(none)';

  // Every other row that records the same server, in either identifier column. The bot's
  // membership in a server is shared by all of them, so this command reports them rather than
  // acting on a server that another connection also records.
  const sharers = serverId
    ? await db
        .select({
          id: platform_integrations.id,
          platform_installation_id: platform_integrations.platform_installation_id,
          platform_account_id: platform_integrations.platform_account_id,
        })
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DISCORD),
            ne(platform_integrations.id, integrationId),
            or(
              eq(platform_integrations.platform_installation_id, serverId),
              and(
                eq(platform_integrations.platform_account_id, serverId),
                isNull(platform_integrations.platform_installation_id)
              )
            )
          )
        )
    : [];

  console.log('\n--- Integration ---');
  console.log(`Integration id:  ${integration.id}`);
  console.log(`Platform:        ${integration.platform}`);
  console.log(`Server id:       ${serverId ?? '(none)'}`);
  console.log(`Owner type:      ${ownerType}`);
  console.log(`Owner id:        ${ownerId}`);
  console.log(`Status:          ${integration.integration_status ?? '(none)'}`);
  console.log(`Other rows on this server: ${sharers.length}`);
  for (const row of sharers) {
    console.log(`  ${row.id}`);
  }

  const skipCode: SkipCode | null = !serverId
    ? 'no_server'
    : sharers.length > 0
      ? 'shared_server'
      : integration.owned_by_user_id || integration.owned_by_organization_id
        ? null
        : 'no_owner';

  console.log('\n--- Decision ---');
  if (skipCode) {
    console.log(`Skipped: ${skipCode}`);
    if (skipCode === 'shared_server') {
      console.log('Another connection also records this server, so its bot membership is shared.');
      console.log('Remove that connection first, then run this command again.');
    }
    console.log('Nothing deleted.');
    process.exitCode = 1;
    return;
  }

  console.log('Action: remove');
  console.log(`Discord server for this row: ${serverId}`);
  console.log('Remove the Kilo bot from that server in the Discord client. This command');
  console.log('removes the local row and makes no Discord request.');

  if (!execute) {
    console.log('Dry run: nothing deleted');
    return;
  }

  // The decision above refuses a row without a server, so this value is set here.
  if (!serverId) {
    throw new Error('This command removes a row that records a Discord server');
  }

  const deleted = await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.DISCORD),
        // The delete names the server the command printed, so it removes the row that was
        // read and only while that row still records this server.
        or(
          eq(platform_integrations.platform_installation_id, serverId),
          and(
            eq(platform_integrations.platform_account_id, serverId),
            isNull(platform_integrations.platform_installation_id)
          )
        )
      )
    )
    .returning({ id: platform_integrations.id });

  console.log(`Deleted rows: ${deleted.length}`);

  if (deleted.length === 1) return;

  console.error(`Skipped: changed (expected to delete exactly one row, deleted ${deleted.length})`);
  process.exitCode = 1;
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
