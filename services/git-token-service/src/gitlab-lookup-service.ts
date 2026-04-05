import * as z from 'zod';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  platform_integrations,
  organization_memberships,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';

export type GitLabLookupParams = {
  userId: string;
  orgId?: string;
};

export type GitLabIntegrationMetadata = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  gitlab_instance_url?: string;
  client_id?: string;
  client_secret?: string;
  auth_type?: 'oauth' | 'pat';
};

type GitLabLookupSuccess = {
  success: true;
  integrationId: string;
  metadata: GitLabIntegrationMetadata;
};

type GitLabLookupFailure = {
  success: false;
  reason: 'database_not_configured' | 'no_integration_found' | 'invalid_org_id';
};

export type GitLabLookupResult = GitLabLookupSuccess | GitLabLookupFailure;

const GitLabMetadataSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    token_expires_at: z.string().optional(),
    gitlab_instance_url: z.string().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    auth_type: z.enum(['oauth', 'pat']).optional(),
  })
  .passthrough();

export class GitLabLookupService {
  private db: WorkerDb | null = null;

  constructor(private env: CloudflareEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE);
  }

  private getDb(): WorkerDb {
    if (!this.db) {
      if (!this.env.HYPERDRIVE) {
        throw new Error('Hyperdrive not configured');
      }
      this.db = getWorkerDb(this.env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
    }
    return this.db;
  }

  async findGitLabIntegration(params: GitLabLookupParams): Promise<GitLabLookupResult> {
    if (!this.isConfigured()) {
      return { success: false, reason: 'database_not_configured' };
    }

    if (params.orgId !== undefined && !z.string().uuid().safeParse(params.orgId).success) {
      return { success: false, reason: 'invalid_org_id' };
    }

    const db = this.getDb();

    const rows = await db
      .select({
        id: platform_integrations.id,
        metadata: platform_integrations.metadata,
      })
      .from(platform_integrations)
      .leftJoin(
        organization_memberships,
        and(
          eq(
            platform_integrations.owned_by_organization_id,
            organization_memberships.organization_id
          ),
          eq(organization_memberships.kilo_user_id, params.userId)
        )
      )
      .innerJoin(
        kilocode_users,
        and(eq(kilocode_users.id, params.userId), isNull(kilocode_users.blocked_reason))
      )
      .where(
        and(
          eq(platform_integrations.platform, 'gitlab'),
          eq(platform_integrations.integration_status, 'active'),
          params.orgId
            ? and(
                eq(platform_integrations.owned_by_organization_id, sql`${params.orgId}::uuid`),
                isNotNull(organization_memberships.id)
              )
            : and(
                isNotNull(platform_integrations.owned_by_user_id),
                eq(platform_integrations.owned_by_user_id, params.userId)
              )
        )
      )
      .limit(1);

    if (rows.length === 0) {
      return { success: false, reason: 'no_integration_found' };
    }

    const row = rows[0];
    const metadata = GitLabMetadataSchema.parse(row.metadata ?? {});

    return {
      success: true,
      integrationId: row.id,
      metadata,
    };
  }
}
