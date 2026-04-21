import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createRedisState } from '@chat-adapter/state-redis';
import { createMemoryState } from '@chat-adapter/state-memory';
import { botIdentityRedisKey } from '@/lib/redis-keys';
import { SLACK_SIGNING_SECRET } from '@/lib/config.server';

const slackAdapter = createSlackAdapter({
  signingSecret: SLACK_SIGNING_SECRET,
});

const backfillBot = new Chat({
  userName: 'Kilo',
  adapters: { slack: slackAdapter },
  state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
});

type SlackIntegrationRow = {
  id: string;
  platformInstallationId: string | null;
  platformAccountLogin: string | null;
  createdByUserId: string | null;
  metadata: unknown;
};

function extractInstallationData(row: SlackIntegrationRow): {
  teamId: string;
  botToken: string;
  botUserId?: string;
  teamName?: string;
} | null {
  const teamId = row.platformInstallationId;
  if (!teamId) {
    console.warn(`Skipping integration ${row.id}: missing platform_installation_id`);
    return null;
  }

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const botToken = metadata.access_token;
  if (typeof botToken !== 'string' || !botToken) {
    console.warn(
      `Skipping integration ${row.id} (team ${teamId}): missing access_token in metadata`
    );
    return null;
  }
  const botUserId = metadata.bot_user_id;
  if (typeof botUserId !== 'string') {
    console.warn(
      `Skipping integration ${row.id} (team ${teamId}): missing bot_user_id in metadata`
    );
    return null;
  }

  return {
    teamId,
    botToken,
    botUserId,
    teamName: row.platformAccountLogin ?? undefined,
  };
}

async function run(): Promise<void> {
  console.log('Fetching existing Slack platform integrations...');

  const rows = await db
    .select({
      id: platform_integrations.id,
      platformInstallationId: platform_integrations.platform_installation_id,
      platformAccountLogin: platform_integrations.platform_account_login,
      createdByUserId: platform_integrations.created_by_user_id,
      metadata: platform_integrations.metadata,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, 'slack'),
        eq(platform_integrations.integration_status, 'active')
      )
    );

  console.log(`Found ${rows.length} active Slack integration(s)`);

  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  await backfillBot.initialize();
  const adapter = backfillBot.getAdapter('slack');

  let installSuccessCount = 0;
  let installSkipCount = 0;
  let identitySuccessCount = 0;
  let identitySkipCount = 0;

  const state = backfillBot.getState();

  for (const row of rows) {
    const data = extractInstallationData(row);
    if (!data) {
      installSkipCount++;
      identitySkipCount++;
      continue;
    }

    try {
      await adapter.setInstallation(data.teamId, {
        botToken: data.botToken,
        botUserId: data.botUserId,
        teamName: data.teamName,
      });
      console.log(
        `Backfilled installation for team ${data.teamId} (${data.teamName ?? 'unknown name'})`
      );
      installSuccessCount++;
    } catch (error) {
      console.error(
        `Failed to backfill installation for team ${data.teamId}:`,
        error instanceof Error ? error.message : String(error)
      );
      installSkipCount++;
    }

    const authedUserId = (row.metadata as Record<string, unknown> | null)?.authed_user_id;
    const kiloUserId = row.createdByUserId;

    if (typeof authedUserId === 'string' && authedUserId && kiloUserId) {
      try {
        await state.set(botIdentityRedisKey('slack', data.teamId, authedUserId), kiloUserId);
        console.log(
          `Backfilled identity for team ${data.teamId} user ${authedUserId} -> ${kiloUserId}`
        );
        identitySuccessCount++;
      } catch (error) {
        console.error(
          `Failed to backfill identity for team ${data.teamId} user ${authedUserId}:`,
          error instanceof Error ? error.message : String(error)
        );
        identitySkipCount++;
      }
    } else {
      console.warn(
        `Skipping identity backfill for team ${data.teamId}: missing authed_user_id or created_by_user_id`
      );
      identitySkipCount++;
    }
  }

  console.log(
    `\nInstallation backfill: ${installSuccessCount} succeeded, ${installSkipCount} skipped/failed`
  );
  console.log(
    `Identity backfill: ${identitySuccessCount} succeeded, ${identitySkipCount} skipped/failed`
  );
}

void run()
  .then(async () => {
    await closeAllDrizzleConnections();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Backfill script failed:', error);
    await closeAllDrizzleConnections();
    process.exit(1);
  });
