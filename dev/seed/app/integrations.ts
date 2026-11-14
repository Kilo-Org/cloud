import { platform_integrations, organizations } from '@kilocode/db/schema';
import { and, eq, like, or } from 'drizzle-orm';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

export const usage = '<user-id> [--org=<organization-id>] [--clear]';

/** Every id this topic writes carries this prefix, so a rerun clears only its own rows. */
const FIXTURE_PREFIX = 'devseed-integrations';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:integrations ${usage}`);
  console.log('');
  console.log('Fills the Integrations hub with active, fake platform_integrations rows for one');
  console.log('owner, so the mobile screens can be exercised without a real OAuth install.');
  console.log('No provider is contacted: the account labels and ids are invented, and the');
  console.log('Disconnect actions that only touch the row (Discord, GitLab) are safe.');
  console.log('');
  console.log('Options:');
  console.log('  --org=<organization-id>  Seed the organization scope instead of the personal one');
  console.log("  --clear                  Remove this fixture's rows and exit");
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:integrations <user-id>');
  console.log('  pnpm dev:seed app:integrations <user-id> --org <organization-id>');
  console.log('  pnpm dev:seed app:integrations <user-id> --clear');
}

type Options = {
  userId: string;
  organizationId: string | null;
  clear: boolean;
};

function takeValue(args: string[], index: number, flag: string): string {
  const arg = args[index];
  if (arg.length > flag.length && arg[flag.length] === '=') {
    const inline = arg.slice(flag.length + 1).trim();
    if (!inline) throw new Error(`${flag} requires a value`);
    return inline;
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return next.trim();
}

function parseArgs(args: string[]): Options {
  let userId: string | null = null;
  let organizationId: string | null = null;
  let clear = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--clear') {
      clear = true;
      continue;
    }
    if (arg === '--org' || arg.startsWith('--org=')) {
      organizationId = takeValue(args, index, '--org');
      if (arg === '--org') index++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (userId !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    userId = arg.trim();
  }

  if (!userId) {
    printUsage();
    throw new Error('user-id is required');
  }
  return { userId, organizationId, clear };
}

/**
 * The fixture rows. Every provider the hub lists is connected, so one run shows
 * the full connected state; Discord is included because the hub only offers it
 * once it is installed.
 */
function fixtureRows(owner: { userId: string; organizationId: string | null }) {
  const owned = owner.organizationId
    ? { owned_by_user_id: null, owned_by_organization_id: owner.organizationId }
    : { owned_by_user_id: owner.userId, owned_by_organization_id: null };
  // One account can hold both a personal scope and several organizations, and
  // Slack's and Linear's installation ids are unique across the whole table, so
  // every id carries the owner it belongs to.
  const ownerKey = owner.organizationId ?? 'personal';
  const id = (suffix: string) => `${FIXTURE_PREFIX}-${ownerKey}-${suffix}`;

  return [
    {
      ...owned,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: id('github'),
      platform_account_id: id('github-account'),
      platform_account_login: 'devseed-acme',
      integration_status: 'active',
      repository_access: 'all',
      repositories: [],
      github_app_type: 'standard',
    },
    {
      ...owned,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: id('slack-team'),
      platform_account_id: id('slack-team'),
      platform_account_login: 'devseed-workspace',
      integration_status: 'active',
    },
    {
      ...owned,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_installation_id: id('gitlab'),
      platform_account_id: id('gitlab-account'),
      platform_account_login: 'devseed-gitlab',
      integration_status: 'active',
      metadata: { gitlab_instance_url: 'https://gitlab.com', auth_type: 'oauth' },
    },
    {
      ...owned,
      platform: 'discord',
      integration_type: 'oauth',
      platform_installation_id: id('discord-guild'),
      platform_account_id: id('discord-guild'),
      platform_account_login: 'devseed-server',
      integration_status: 'active',
    },
    {
      ...owned,
      platform: 'linear',
      integration_type: 'oauth',
      platform_installation_id: id('linear-workspace'),
      platform_account_id: id('linear-workspace'),
      platform_account_login: 'devseed-linear',
      integration_status: 'active',
    },
    ...(owner.organizationId
      ? [
          {
            ...owned,
            platform: 'bitbucket',
            integration_type: 'oauth',
            platform_installation_id: id('bitbucket'),
            platform_account_id: id('bitbucket-workspace'),
            platform_account_login: 'devseed-bitbucket',
            integration_status: 'active',
            metadata: { auth_type: 'oauth' },
          },
        ]
      : []),
  ] satisfies (typeof platform_integrations.$inferInsert)[];
}

async function removeFixtureRows(owner: {
  userId: string;
  organizationId: string | null;
}): Promise<number> {
  const db = getSeedDb();
  const fixture = or(
    like(platform_integrations.platform_installation_id, `${FIXTURE_PREFIX}%`),
    like(platform_integrations.platform_account_id, `${FIXTURE_PREFIX}%`)
  );
  // One account can seed its personal scope and several organizations in the
  // same database, so a rerun clears only the owner it is about to write.
  const owned = owner.organizationId
    ? eq(platform_integrations.owned_by_organization_id, owner.organizationId)
    : eq(platform_integrations.owned_by_user_id, owner.userId);
  const deleted = await db
    .delete(platform_integrations)
    .where(and(fixture, owned))
    .returning({ id: platform_integrations.id });
  return deleted.length;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);
  assertLocalSeedDatabase('app:integrations');
  const db = getSeedDb();

  const removed = await removeFixtureRows(options);
  if (options.clear) {
    console.log(`Removed ${removed} seeded integration row(s).`);
    return { cleared: removed };
  }

  if (options.organizationId) {
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, options.organizationId))
      .limit(1);
    if (!organization) {
      throw new Error(
        `Organization ${options.organizationId} was not found. Create the fixture organization first ` +
          `(pnpm dev:seed organization:create-user <user-id>).`
      );
    }
  }

  const rows = fixtureRows({
    userId: options.userId,
    organizationId: options.organizationId,
  });
  const inserted = await db.insert(platform_integrations).values(rows).returning({
    id: platform_integrations.id,
    platform: platform_integrations.platform,
  });

  console.log('This fixture represents: every integration the hub lists, connected.');
  console.log('Note: no provider was contacted. A Disconnect that revokes a real token will');
  console.log('fail for GitHub, Slack and Linear; Discord removes the row and GitLab suspends it.');
  console.log('Suggested next step: open Profile > Integrations in the app.');

  const result: SeedResult = {
    userId: options.userId,
    organizationId: options.organizationId,
    removedBeforeInsert: removed,
    seededRows: inserted.length,
  };
  for (const row of inserted) {
    result[`${row.platform}IntegrationId`] = row.id;
  }
  return result;
}
