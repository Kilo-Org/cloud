import { kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import {
  fetchSeedGitHubInstallationDetails,
  fetchSeedGitHubRepositories,
  type SeedGitHubAppType,
} from '../lib/github-app';
import type { SeedResult } from '../index';

export const usage =
  '<user-id> --installation-id=<id> [--repository=<owner/repo>] [--app-type=standard|lite]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:github-integration ${usage}`);
  console.log('');
  console.log('Connects a local development user to an existing GitHub App installation by');
  console.log('upserting an active user-owned platform_integrations row. The installation and');
  console.log('the optional repository are validated against GitHub with the configured app');
  console.log('credentials (GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY, or the GITHUB_LITE_APP_* pair).');
  console.log('No private keys or tokens are printed or stored; git-token-service mints the');
  console.log('installation token at runtime.');
  console.log('');
  console.log('Options:');
  console.log('  --installation-id=<id>     GitHub App installation id (required)');
  console.log(
    '  --repository=<owner/repo>  Repository that must be accessible to the installation'
  );
  console.log('  --app-type=standard|lite   GitHub App to validate against (default: standard)');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:github-integration <user-id> --installation-id 107732005 \\');
  console.log('    --repository na2-org/hi-how-are-you');
  console.log('  pnpm dev:seed app:github-integration <user-id> --installation-id=107732005');
}

type GitHubIntegrationOptions = {
  userId: string;
  installationId: string;
  repository: string | null;
  appType: SeedGitHubAppType;
};

function takeFlagValue(args: string[], index: number, flag: string): string {
  const inline = args[index].slice(flag.length + 1).trim();
  if (inline) return inline;

  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return next.trim();
}

function parseArgs(args: string[]): GitHubIntegrationOptions {
  let userId: string | null = null;
  let installationId: string | null = null;
  let repository: string | null = null;
  let appType: SeedGitHubAppType = 'standard';

  const VALUE_FLAGS = ['--installation-id', '--repository', '--app-type'];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const flag = VALUE_FLAGS.find(name => arg === name || arg.startsWith(`${name}=`));

    if (flag) {
      const value = takeFlagValue(args, index, flag);
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      if (arg === flag) index++; // value came from the next argv slot

      if (flag === '--installation-id') {
        if (!/^\d+$/.test(value)) {
          throw new Error('--installation-id must be a numeric GitHub installation id');
        }
        installationId = value;
      } else if (flag === '--repository') {
        if (!/^[^\s/]+\/[^\s/]+$/.test(value)) {
          throw new Error('--repository must look like owner/repo');
        }
        repository = value;
      } else {
        if (value !== 'standard' && value !== 'lite') {
          throw new Error('--app-type must be standard or lite');
        }
        appType = value;
      }
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
  if (!installationId) {
    printUsage();
    throw new Error('--installation-id is required');
  }

  return { userId, installationId, repository, appType };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);
  const db = getSeedDb();

  const [user] = await db
    .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, options.userId))
    .limit(1);

  if (!user) {
    throw new Error(
      `User ${options.userId} was not found. Create one first: ` +
        `pnpm dev:seed app:create-user "Cloud Agent Test" cloud-agent-test@example.com`
    );
  }

  // Validate against GitHub before writing anything, mirroring the dev-only
  // devAddInstallation flow in apps/web/src/routers/github-apps-router.ts.
  const details = await fetchSeedGitHubInstallationDetails(options.installationId, options.appType);
  const repositories = await fetchSeedGitHubRepositories(options.installationId, options.appType);

  let canonicalRepository: string | null = null;
  if (options.repository) {
    const requested = options.repository.toLowerCase();
    const match = repositories.find(repo => repo.full_name.toLowerCase() === requested);
    if (!match) {
      const sample = repositories
        .slice(0, 5)
        .map(repo => repo.full_name)
        .join(', ');
      throw new Error(
        `Repository ${options.repository} is not accessible to installation ${options.installationId} ` +
          `(${details.accountLogin}, repository access: ${details.repositorySelection}, ` +
          `${repositories.length} repositories${sample ? `: ${sample}${repositories.length > 5 ? ', …' : ''}` : ''}). ` +
          `Grant the app access to the repository on GitHub first.`
      );
    }
    canonicalRepository = match.full_name;
  }

  // Upsert replicating upsertPlatformIntegrationForOwner from
  // apps/web/src/lib/integrations/db/platform-integrations.ts (GitHub two-step
  // pattern): insert against the global (platform, github_app_type,
  // platform_installation_id) unique index, then re-read on conflict to allow a
  // same-owner refresh and refuse cross-owner claims.
  const nowIso = new Date().toISOString();
  const values = {
    owned_by_user_id: user.id,
    owned_by_organization_id: null,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: options.installationId,
    platform_account_id: String(details.accountId),
    platform_account_login: details.accountLogin,
    permissions: details.permissions,
    scopes: details.events,
    repository_access: details.repositorySelection,
    integration_status: 'active',
    repositories,
    installed_at: details.createdAt,
    github_app_type: options.appType,
    repositories_synced_at: nowIso,
  } satisfies typeof platform_integrations.$inferInsert;

  const inserted = await db
    .insert(platform_integrations)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: platform_integrations.id });

  let integrationId: string;
  let wasInserted: boolean;

  if (inserted.length > 0) {
    const [row] = inserted;
    integrationId = row.id;
    wasInserted = true;
  } else {
    const [existing] = await db
      .select({
        id: platform_integrations.id,
        ownedByUserId: platform_integrations.owned_by_user_id,
        ownedByOrganizationId: platform_integrations.owned_by_organization_id,
      })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.github_app_type, options.appType),
          eq(platform_integrations.platform_installation_id, options.installationId)
        )
      )
      .limit(1);

    if (!existing) {
      // Edge case: a concurrent delete blocked the insert without leaving a row
      // to re-read. Retry so the database enforces uniqueness (or throws).
      const [retried] = await db
        .insert(platform_integrations)
        .values(values)
        .returning({ id: platform_integrations.id });
      integrationId = retried.id;
      wasInserted = true;
    } else if (existing.ownedByUserId === user.id && existing.ownedByOrganizationId === null) {
      await db
        .update(platform_integrations)
        .set({
          platform_account_id: values.platform_account_id,
          platform_account_login: values.platform_account_login,
          permissions: values.permissions,
          scopes: values.scopes,
          repository_access: values.repository_access,
          integration_status: 'active',
          repositories: values.repositories,
          github_app_type: options.appType,
          auth_invalid_at: null,
          auth_invalid_reason: null,
          repositories_synced_at: nowIso,
          updated_at: nowIso,
        })
        .where(eq(platform_integrations.id, existing.id));
      integrationId = existing.id;
      wasInserted = false;
    } else {
      const ownerHint = existing.ownedByUserId
        ? `user ${existing.ownedByUserId}`
        : `organization ${existing.ownedByOrganizationId ?? 'unknown'}`;
      throw new Error(
        `This GitHub installation is already claimed by another account (${ownerHint}). ` +
          `Delete that platform_integrations row first, or seed the integration for the owning account.`
      );
    }
  }

  console.log('');
  console.log(
    'This fixture represents: a user-owned GitHub App integration (platform_integrations row)'
  );
  console.log('for local Cloud Agent web testing.');
  console.log(
    'Note: no keys or tokens were stored; git-token-service mints the installation token at runtime.'
  );
  if (canonicalRepository) {
    console.log(
      `Suggested next step: start a Cloud Agent session against ${canonicalRepository} from the web app.`
    );
  }

  return {
    userId: user.id,
    userEmail: user.email,
    integrationId,
    inserted: wasInserted,
    installationId: options.installationId,
    appType: options.appType,
    accountLogin: details.accountLogin,
    accountId: String(details.accountId),
    repositoryAccess: details.repositorySelection,
    repositoryCount: repositories.length,
    repository: canonicalRepository,
  };
}
