import { cli_sessions_v2, platform_integrations } from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import { and, eq, isNull, like } from 'drizzle-orm';

import { getSeedDb } from './db';

export const FIXTURE_SESSION_ID = 'ses_e2efreqrepo000000000000001';
export const FIXTURE_CLOUD_AGENT_SESSION_ID = 'e2e-frequent-repository-ordering-ad1a';
export const FIXTURE_SESSION_PREFIX = 'ses_e2efreqrepo';
export const FIXTURE_INSTALLATION_ID = '144771093';
export const FIXTURE_CREATED_ON_PLATFORM = 'cloud-agent';

export type FrequentRepositoryOrderFixture = {
  userId: string;
  integrationId: string;
  unusedRepository: string;
  usedRepository: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasNumericId(value: unknown): boolean {
  return isRecord(value) && typeof value['id'] === 'number';
}

function repositoryFullNameAt(repositories: unknown[], index: number): string {
  const entry = repositories[index];
  if (!isRecord(entry)) {
    throw new Error(`fixture repository at index ${index} must be an object`);
  }
  const fullName = entry['full_name'];
  if (typeof fullName !== 'string' || fullName === '') {
    throw new Error(`fixture repository at index ${index} must have a nonempty full_name`);
  }
  return fullName;
}

export function normalizedGitHubUrl(fullName: string): string {
  return normalizeGitUrl(`https://github.com/${fullName}`);
}

/**
 * Extract the first two provider-order repositories from the cached
 * `platform_integrations.repositories` array. The array must hold at least two
 * real repositories (numeric GitHub id), and the first two entries must have
 * nonempty, distinct full names.
 */
export function resolveFixtureRepositories(repositories: unknown): {
  unusedRepository: string;
  usedRepository: string;
} {
  if (!Array.isArray(repositories)) {
    throw new Error('fixture requires a cached repositories array on the GitHub integration');
  }
  const numericCount = repositories.filter(hasNumericId).length;
  if (numericCount < 2) {
    throw new Error(
      `fixture requires at least two cached repositories with numeric id, found ${numericCount}`
    );
  }
  const unusedRepository = repositoryFullNameAt(repositories, 0);
  const usedRepository = repositoryFullNameAt(repositories, 1);
  if (unusedRepository === usedRepository) {
    throw new Error('fixture requires two different repositories');
  }
  return { unusedRepository, usedRepository };
}

export function buildFixtureInsertValues(
  userId: string,
  usedRepository: string
): typeof cli_sessions_v2.$inferInsert {
  return {
    session_id: FIXTURE_SESSION_ID,
    kilo_user_id: userId,
    organization_id: null,
    parent_session_id: null,
    cloud_agent_session_id: FIXTURE_CLOUD_AGENT_SESSION_ID,
    cloud_agent_session_scope_id: FIXTURE_CLOUD_AGENT_SESSION_ID,
    created_on_platform: FIXTURE_CREATED_ON_PLATFORM,
    git_url: normalizedGitHubUrl(usedRepository),
    version: 0,
  } satisfies typeof cli_sessions_v2.$inferInsert;
}

export function isFixtureCloudAgentConflict(existingCloudAgentSessionId: string | null): boolean {
  return existingCloudAgentSessionId !== FIXTURE_CLOUD_AGENT_SESSION_ID;
}

export function fixtureCloudAgentConflictError(existingCloudAgentSessionId: string | null): Error {
  return new Error(
    `Cloud Agent root session identity conflict: session ${FIXTURE_SESSION_ID} already belongs to Cloud Agent ${existingCloudAgentSessionId ?? 'null'}, expected ${FIXTURE_CLOUD_AGENT_SESSION_ID}`
  );
}

export async function readFixtureIntegration(
  userId: string
): Promise<FrequentRepositoryOrderFixture> {
  const db = getSeedDb();
  const rows = await db
    .select({
      id: platform_integrations.id,
      platformInstallationId: platform_integrations.platform_installation_id,
      integrationStatus: platform_integrations.integration_status,
      repositories: platform_integrations.repositories,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_user_id, userId),
        isNull(platform_integrations.owned_by_organization_id),
        eq(platform_integrations.platform, 'github')
      )
    );

  if (rows.length !== 1) {
    throw new Error(
      `fixture requires exactly one user-owned GitHub integration for user ${userId}, found ${rows.length}`
    );
  }
  const [row] = rows;

  if (row.platformInstallationId !== FIXTURE_INSTALLATION_ID) {
    throw new Error(
      `fixture requires GitHub installation ${FIXTURE_INSTALLATION_ID}, found ${row.platformInstallationId ?? 'none'}`
    );
  }
  if (row.integrationStatus !== 'active') {
    throw new Error(
      `fixture requires an active integration, found ${row.integrationStatus ?? 'none'}`
    );
  }

  const { unusedRepository, usedRepository } = resolveFixtureRepositories(row.repositories);
  return { userId, integrationId: row.id, unusedRepository, usedRepository };
}

export function fixtureSessionDeletePredicate(userId: string) {
  return and(
    eq(cli_sessions_v2.session_id, FIXTURE_SESSION_ID),
    eq(cli_sessions_v2.kilo_user_id, userId),
    like(cli_sessions_v2.session_id, `${FIXTURE_SESSION_PREFIX}%`)
  );
}

export async function deleteFixtureSessions(userId: string): Promise<void> {
  const db = getSeedDb();
  await db.delete(cli_sessions_v2).where(fixtureSessionDeletePredicate(userId));
}

export async function insertFixtureSession(userId: string, usedRepository: string): Promise<void> {
  const db = getSeedDb();
  const values = buildFixtureInsertValues(userId, usedRepository);

  const inserted = await db
    .insert(cli_sessions_v2)
    .values(values)
    .onConflictDoNothing({ target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id] })
    .returning();

  if (inserted.length > 0) {
    return;
  }

  const [existing] = await db
    .select({ cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.session_id, FIXTURE_SESSION_ID),
        eq(cli_sessions_v2.kilo_user_id, userId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new Error('fixture insert conflicted but the existing row disappeared');
  }
  if (isFixtureCloudAgentConflict(existing.cloudAgentSessionId)) {
    throw fixtureCloudAgentConflictError(existing.cloudAgentSessionId);
  }
}
