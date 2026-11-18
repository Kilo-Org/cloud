import { randomUUID } from 'node:crypto';

import {
  agent_configs,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<fake-email> [--count <n>]';

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

/**
 * The provider's owner split of a large account: a few owners, many names. The
 * owner cycle is deliberately not a divisor of the name cycle below, so a name
 * stem repeats under different owners instead of circling back to the same one.
 */
const LONG_LIST_OWNERS = [
  'picker-lab',
  'picker-lab-platform',
  'picker-lab-mobile',
  'long-list-lab',
];

const LONG_LIST_WORDS = [
  'service',
  'dashboard',
  'infra',
  'design-system',
  'documentation',
  'cli',
  'api',
  'web',
  'mobile',
  'analytics',
  'billing',
  'auth',
  'search',
  'notifications',
  'gateway',
];

/**
 * A snapshot a real account of this size has: several owners, one name stem
 * repeated across them, private rows in the majority and a band of names long
 * enough that the row has to truncate. The entries keep the provider's shape,
 * so the pickers render them through the same rows as any other snapshot.
 */
function longListSnapshot(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const owner = LONG_LIST_OWNERS[index % LONG_LIST_OWNERS.length];
    const word = LONG_LIST_WORDS[index % LONG_LIST_WORDS.length];
    // 48 long names, as the explorer measured on the account this fixture
    // stands for: past 60 characters a row can only show a middle ellipsis.
    const name =
      index < 48
        ? `${word}-with-a-deliberately-long-descriptive-repository-name-${index}`
        : `${word}-${index}`;
    return {
      id: 9001 + index,
      name,
      full_name: `${owner}/${name}`,
      private: index % 5 !== 0,
      archived: index % 41 === 0,
      default_branch: 'main',
    };
  });
}

/** The repositories a long snapshot starts with selected: a few it still maintains. */
function longListSelection(repositories: { id: number }[]): number[] {
  return repositories.filter((_, index) => index % 33 === 0).map(repository => repository.id);
}

/** Fixed so a rerun replaces the same organization, integration and configs. */
const ORGANIZATION_ID = '5d0f6b21-8f3c-4a19-9a74-2c6e1b0d8f53';

/**
 * `--count <n>` (or `--count=<n>`) swaps the two-row snapshot for a long one;
 * absent keeps the pair. Any other argument is a usage error, so a typo cannot
 * silently seed the wrong fixture.
 */
function parseCount(flags: string[]): number | null {
  let raw: string | null = null;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--count') {
      const value = flags[index + 1];
      if (value === undefined) {
        printUsage();
        throw new Error('--count needs a number of repositories.');
      }
      raw = value;
      index += 1;
      continue;
    }
    if (flag?.startsWith('--count=')) {
      raw = flag.slice('--count='.length);
      continue;
    }
    printUsage();
    throw new Error(`Unknown argument "${String(flag)}".`);
  }
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) {
    throw new Error('--count takes a whole number of repositories between 1 and 2000.');
  }
  return parsed;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-repository-picker ${usage}`);
  console.log('');
  console.log('Seeds an organization whose cached repository snapshot holds one private and');
  console.log('one public repository, with both pickers set to "selected" so their rows');
  console.log('render immediately. Used to check how the repository rows are announced.');
  console.log('');
  console.log('--count <n> seeds a long snapshot of n repositories instead: several owners,');
  console.log('a private majority and a band of names long enough for a row to truncate.');
  console.log('That is the state a picker has to stay usable in, so it is what the search');
  console.log('field and the virtualized rows are checked against.');
  console.log('');
  console.log('Refuses non-loopback databases and USE_PRODUCTION_DB=true; never calls GitHub.');
  console.log('No Stripe customer is created, so keep to the pickers: an organization billing');
  console.log('surface for this account has no customer behind it.');
  console.log('Sign the mobile development client in as the returned account, then open the');
  console.log('returned deep links.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...flags] = args;
  const count = parseCount(flags);
  if (!email || !/^[a-z0-9][a-z0-9-]*@example\.(com|test)$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching <name>@example.com.');
  }

  const repositories = count === null ? REPOSITORIES : longListSnapshot(count);

  assertLocalSeedDatabase('app:mobile-repository-picker');
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
    repositories,
    repositories_synced_at: new Date(),
    installed_at: new Date(),
  });

  const selectedRepositoryIds =
    count === null
      ? repositories.map(repository => repository.id)
      : longListSelection(repositories);
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
    count === null
      ? 'This fixture represents: an organization whose repository list holds one private and one public repository, with both pickers scoped to them.'
      : 'This fixture represents: an organization whose cached snapshot holds a long repository list, the state a picker must stay usable in.'
  );
  console.log(
    'No installation token is minted and no provider request is made: the pickers read the seeded snapshot.'
  );
  // The names a follow-up command can use come from the snapshot that was
  // seeded, not from the two-row default: with a long snapshot the constants
  // above are not inserted at all.
  const seededPrivate = repositories.find(repository => repository.private);
  const seededPublic = repositories.find(repository => !repository.private);
  return {
    email,
    userId,
    organizationId: ORGANIZATION_ID,
    repositoryCount: repositories.length,
    selectedCount: selectedRepositoryIds.length,
    privateRepoFullName: seededPrivate?.full_name ?? null,
    publicRepoFullName: seededPublic?.full_name ?? null,
    securityAgentDeepLink: `kiloapp:///(app)/security-agent/${ORGANIZATION_ID}/settings/repositories`,
    codeReviewerDeepLink: `kiloapp:///(app)/code-reviewer/${ORGANIZATION_ID}/github/repos`,
    repoBindingsDeepLink: `kiloapp:///(app)/profile-management/repo-bindings?organizationId=${ORGANIZATION_ID}`,
  };
}
