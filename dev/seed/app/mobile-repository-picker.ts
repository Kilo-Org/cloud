import { randomUUID } from 'node:crypto';

import { computeDatabaseUrl } from '@kilocode/db';
import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/**
 * The pickers read this snapshot instead of calling the provider for every
 * list, so the fixture below is the whole provider state they see. Both entries
 * are readable, so the routers never fall back to a provider fetch.
 */
const REPOSITORIES = [
  {
    id: 9001,
    name: 'private-repo',
    full_name: 'picker-lab/private-repo',
    private: true,
    archived: false,
    default_branch: 'main',
  },
  {
    id: 9002,
    name: 'public-repo',
    full_name: 'picker-lab/public-repo',
    private: false,
    archived: false,
    default_branch: 'main',
  },
];

/** Fixed so a rerun replaces the same organization, integration and configs. */
const ORGANIZATION_ID = '5d0f6b21-8f3c-4a19-9a74-2c6e1b0d8f53';

/** Refuses to touch anything but a loopback database, whatever the env says. */
function assertLocalDatabaseTarget(): string {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('The repository picker seed refuses to run with USE_PRODUCTION_DB=true.');
  }

  const databaseUrl = new URL(computeDatabaseUrl());
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname)) {
    throw new Error(
      `The repository picker seed requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }

  return databaseUrl.hostname;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-repository-picker ${usage}`);
  console.log('');
  console.log('Seeds an organization whose cached repository snapshot holds one private and');
  console.log('one public repository, with both pickers set to "selected" so their rows');
  console.log('render immediately. Used to check how the repository rows are announced.');
  console.log('');
  console.log('Refuses non-loopback databases and USE_PRODUCTION_DB=true; never calls GitHub.');
  console.log('Sign the mobile development client in as the returned account, then open the');
  console.log('returned deep links.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...extra] = args;
  if (!email || extra.length || !/^[a-z0-9][a-z0-9-]*@example\.(com|test)$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching <name>@example.com.');
  }

  assertLocalDatabaseTarget();
  const db = getSeedDb();
  const userId = `dev-seed:mobile-repository-picker:${email}`;
  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, email));
  if (existing && existing.id !== userId) {
    throw new Error('The requested email belongs to a different account; choose a new fake email.');
  }

  await db
    .insert(kilocode_users)
    .values({
      id: userId,
      google_user_email: email,
      normalized_email: email,
      google_user_name: 'Repository picker tester',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_repository_picker_${randomUUID()}`,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();
  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: 'Repository picker lab',
      require_seats: false,
      created_by_kilo_user_id: userId,
    })
    .onConflictDoNothing();
  await db
    .insert(organization_memberships)
    .values({
      organization_id: ORGANIZATION_ID,
      kilo_user_id: userId,
      role: 'owner',
    })
    .onConflictDoNothing();

  await db
    .delete(platform_integrations)
    .where(eq(platform_integrations.owned_by_organization_id, ORGANIZATION_ID));
  await db.delete(agent_configs).where(eq(agent_configs.owned_by_organization_id, ORGANIZATION_ID));

  await db.insert(platform_integrations).values({
    owned_by_organization_id: ORGANIZATION_ID,
    created_by_user_id: userId,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: '9100001',
    platform_account_id: '7100',
    platform_account_login: 'picker-lab',
    integration_status: 'active',
    github_app_type: 'standard',
    github_connection_role: 'workflow',
    repositories: REPOSITORIES,
    repositories_synced_at: new Date(),
    installed_at: new Date(),
  });

  const selectedRepositoryIds = REPOSITORIES.map(repository => repository.id);
  await db.insert(agent_configs).values([
    {
      owned_by_organization_id: ORGANIZATION_ID,
      agent_type: 'code_review',
      platform: 'github',
      config: {
        repository_selection_mode: 'selected',
        selected_repository_ids: selectedRepositoryIds,
      },
      created_by: userId,
    },
    {
      owned_by_organization_id: ORGANIZATION_ID,
      agent_type: 'security_scan',
      platform: 'github',
      config: {
        repository_selection_mode: 'selected',
        selected_repository_ids: selectedRepositoryIds,
        auto_sync_enabled: true,
      },
      created_by: userId,
    },
  ]);

  console.log(
    'This fixture represents: an organization whose repository list holds one private and one public repository, with both pickers scoped to them.'
  );
  console.log(
    'No installation token is minted and no provider request is made: the pickers read the seeded snapshot.'
  );
  return {
    email,
    userId,
    organizationId: ORGANIZATION_ID,
    privateRepoFullName: REPOSITORIES[0].full_name,
    publicRepoFullName: REPOSITORIES[1].full_name,
    securityAgentDeepLink: `kiloapp:///security-agent/${ORGANIZATION_ID}/settings/repositories`,
    codeReviewerDeepLink: `kiloapp:///code-reviewer/${ORGANIZATION_ID}/github/repos`,
    repoBindingsDeepLink: `kiloapp:///profile-management/repo-bindings?organizationId=${ORGANIZATION_ID}`,
  };
}
