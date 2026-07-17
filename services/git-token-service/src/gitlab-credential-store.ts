import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { platform_access_token_credentials, platform_oauth_credentials } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import { GitLabLookupService, type GitLabLookupParams } from './gitlab-lookup-service.js';
import type {
  GitLabCredentialFence,
  GitLabCredentialSelector,
  GitLabCredentialStore,
} from './gitlab-credential-service.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';

export class DrizzleGitLabCredentialStore implements GitLabCredentialStore {
  private lookupService: GitLabLookupService;

  constructor(private env: CloudflareEnv) {
    this.lookupService = new GitLabLookupService(env);
  }

  async findCredential(input: { actor: GitLabLookupParams; selector: GitLabCredentialSelector }) {
    const integration = await this.lookupService.findGitLabIntegration(
      input.actor,
      input.selector.integrationId
    );
    if (!integration.success) {
      if (integration.reason === 'database_not_configured') {
        throw new Error('GitLab credential database is unavailable');
      }
      return null;
    }

    const providerBaseUrl = normalizeGitLabInstanceUrl(
      integration.metadata.gitlab_instance_url ?? DEFAULT_GITLAB_INSTANCE_URL
    );
    const db = this.getDb();
    let credential: unknown = null;
    if (input.selector.credential === 'project-exact') {
      [credential] = await db
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(
              platform_access_token_credentials.platform_integration_id,
              integration.integrationId
            ),
            eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
            eq(platform_access_token_credentials.provider_resource_id, input.selector.projectId)
          )
        )
        .limit(1);
    } else if (integration.integrationType === 'oauth') {
      [credential] = await db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.integrationId))
        .limit(1);
    } else {
      [credential] = await db
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(
              platform_access_token_credentials.platform_integration_id,
              integration.integrationId
            ),
            isNull(platform_access_token_credentials.provider_resource_id)
          )
        )
        .limit(1);
    }

    return {
      parent: {
        integrationId: integration.integrationId,
        platform: 'gitlab',
        integrationType: integration.integrationType,
        integrationStatus: 'active',
        ownedByUserId: input.actor.orgId ? null : input.actor.userId,
        ownedByOrganizationId: input.actor.orgId ?? null,
        providerBaseUrl,
        providerSubjectId: integration.accountId,
        providerSubjectLogin: integration.accountLogin,
      },
      credential,
    };
  }

  async markUsed(fence: GitLabCredentialFence, at: string): Promise<boolean> {
    const db = this.getDb();
    if (fence.credentialTable === 'oauth') {
      const updated = await db
        .update(platform_oauth_credentials)
        .set({ last_used_at: at })
        .where(
          and(
            eq(platform_oauth_credentials.id, fence.credentialId),
            eq(platform_oauth_credentials.platform_integration_id, fence.integrationId),
            eq(platform_oauth_credentials.credential_version, fence.credentialVersion)
          )
        )
        .returning({ id: platform_oauth_credentials.id });
      return updated.length === 1;
    }

    const updated = await db
      .update(platform_access_token_credentials)
      .set({ last_used_at: at })
      .where(
        and(
          eq(platform_access_token_credentials.id, fence.credentialId),
          eq(platform_access_token_credentials.platform_integration_id, fence.integrationId),
          eq(platform_access_token_credentials.credential_version, fence.credentialVersion)
        )
      )
      .returning({ id: platform_access_token_credentials.id });
    return updated.length === 1;
  }

  async hasProjectCredentialCandidates(input: {
    actor: GitLabLookupParams;
    integrationId: string;
  }): Promise<boolean> {
    const integration = await this.lookupService.findGitLabIntegration(
      input.actor,
      input.integrationId
    );
    if (!integration.success) {
      if (integration.reason === 'database_not_configured') {
        throw new Error('GitLab credential database is unavailable');
      }
      return false;
    }
    const rows = await this.getDb()
      .select({ id: platform_access_token_credentials.id })
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.integrationId),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  private getDb(): WorkerDb {
    if (!this.env.HYPERDRIVE) throw new Error('Hyperdrive not configured');
    return getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  }
}
