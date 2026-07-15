import 'server-only';

import { db } from '@/lib/drizzle';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import {
  auditGitLabCredentialProfiles,
  emptyGitLabCredentialAuditCounts,
  hasBlockingGitLabCredentialAuditIssues,
  type GitLabCredentialAuditCounts,
} from './credential-migration-audit';
import {
  countLegacySecretFields,
  GitLabLegacyMetadataSchema,
  hasTokenBearingLegacyMetadata,
} from './credential-migration-legacy';
import { backfillMissingGitLabCredentials } from './credential-migration-backfill';
import { normalizeGitLabInstanceUrl } from './instance-url';
import {
  mutateGitLabMetadataInTransaction,
  readGitLabMetadataInTransaction,
} from './metadata-mutation';

export type GitLabCredentialMigrationMode = 'audit' | 'backfill' | 'scrub';

export type GitLabCredentialMigrationOptions = {
  mode?: GitLabCredentialMigrationMode;
  apply?: boolean;
  batchSize?: number;
  privateAuditPassed?: boolean;
};

export type GitLabCredentialMigrationResult = {
  mode: GitLabCredentialMigrationMode;
  applied: boolean;
  scannedIntegrations: number;
  mutatedIntegrations: number;
  counts: GitLabCredentialAuditCounts;
  integrationIds: string[];
};

export async function runGitLabCredentialMigration(
  options: GitLabCredentialMigrationOptions = {}
): Promise<GitLabCredentialMigrationResult> {
  const mode = options.mode ?? 'audit';
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('GitLab credential migration batch size must be a positive integer');
  }
  if (mode === 'scrub' && options.apply === true) {
    if (options.privateAuditPassed !== true) {
      throw new Error('GitLab credential scrub requires a passing private-key audit assertion');
    }
    const audit = await runGitLabCredentialMigration({ mode: 'audit', batchSize });
    if (hasBlockingGitLabCredentialAuditIssues(audit.counts)) {
      throw new Error('GitLab credential scrub blocked by unresolved public audit issues');
    }
  }

  const result: GitLabCredentialMigrationResult = {
    mode,
    applied: false,
    scannedIntegrations: 0,
    mutatedIntegrations: 0,
    counts: emptyGitLabCredentialAuditCounts(),
    integrationIds: [],
  };
  const issueIntegrationIds = new Set<string>();
  const mutationsEnabled = options.apply === true && mode !== 'audit';
  result.applied = mutationsEnabled;
  let cursor: string | undefined;

  while (true) {
    const batch = await db
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        cursor
          ? and(eq(platform_integrations.platform, 'gitlab'), gt(platform_integrations.id, cursor))
          : eq(platform_integrations.platform, 'gitlab')
      )
      .orderBy(asc(platform_integrations.id))
      .limit(batchSize);
    if (batch.length === 0) break;

    for (const { id: integrationId } of batch) {
      result.scannedIntegrations += 1;
      const mutated = await db.transaction(async tx => {
        let rawMetadata: Record<string, unknown>;
        try {
          rawMetadata = await readGitLabMetadataInTransaction(tx, integrationId);
        } catch {
          if (mode === 'scrub' && mutationsEnabled) {
            throw new Error('GitLab credential scrub blocked by locked public audit');
          }
          result.counts.malformedMetadata += 1;
          result.counts.unmappableLegacyEntries += 1;
          issueIntegrationIds.add(integrationId);
          return false;
        }
        result.counts.legacySecretFields += countLegacySecretFields(rawMetadata);
        if (hasTokenBearingLegacyMetadata(rawMetadata)) {
          result.counts.legacyTokenBearingIntegrations += 1;
        }
        const metadataResult = GitLabLegacyMetadataSchema.safeParse(rawMetadata);
        if (!metadataResult.success) {
          if (mode === 'scrub' && mutationsEnabled) {
            throw new Error('GitLab credential scrub blocked by locked public audit');
          }
          result.counts.malformedMetadata += 1;
          result.counts.unmappableLegacyEntries += 1;
          issueIntegrationIds.add(integrationId);
          return false;
        }
        const metadata = metadataResult.data;
        const [integration] = await tx
          .select()
          .from(platform_integrations)
          .where(eq(platform_integrations.id, integrationId))
          .limit(1);
        if (!integration) throw new Error('GitLab integration not found');
        if (
          Boolean(integration.owned_by_user_id) === Boolean(integration.owned_by_organization_id)
        ) {
          result.counts.unmappableLegacyEntries += 1;
          issueIntegrationIds.add(integrationId);
          return false;
        }
        let providerBaseUrl: string;
        try {
          providerBaseUrl = normalizeGitLabInstanceUrl(metadata.gitlab_instance_url);
        } catch {
          if (mode === 'scrub' && mutationsEnabled) {
            throw new Error('GitLab credential scrub blocked by locked public audit');
          }
          result.counts.malformedMetadata += 1;
          result.counts.unmappableLegacyEntries += 1;
          issueIntegrationIds.add(integrationId);
          return false;
        }
        const projectTokens = metadata.project_tokens ?? {};

        const [oauthCredential] = await tx
          .select()
          .from(platform_oauth_credentials)
          .where(eq(platform_oauth_credentials.platform_integration_id, integrationId))
          .limit(1);
        const [patCredential] = await tx
          .select()
          .from(platform_access_token_credentials)
          .where(
            and(
              eq(platform_access_token_credentials.platform_integration_id, integrationId),
              isNull(platform_access_token_credentials.provider_resource_id)
            )
          )
          .limit(1);
        const accessCredentials = await tx
          .select()
          .from(platform_access_token_credentials)
          .where(eq(platform_access_token_credentials.platform_integration_id, integrationId));
        const projectCredentialIds = new Set(
          accessCredentials.flatMap(row =>
            row.provider_resource_id === null ? [] : [row.provider_resource_id]
          )
        );

        const credentialAudit = auditGitLabCredentialProfiles(
          integration,
          providerBaseUrl,
          oauthCredential,
          accessCredentials
        );
        result.counts.credentialProfileMismatches += credentialAudit.profileMismatches;
        result.counts.providerMetadataMismatches += credentialAudit.providerMetadataMismatches;
        if (
          credentialAudit.profileMismatches > 0 ||
          credentialAudit.providerMetadataMismatches > 0
        ) {
          issueIntegrationIds.add(integrationId);
        }
        if (oauthCredential && patCredential) {
          result.counts.crossTablePrimaryCredentialDuplicates += 1;
          issueIntegrationIds.add(integrationId);
        }

        const oauthCredentialMissing =
          metadata.auth_type === 'oauth' && Boolean(metadata.access_token) && !oauthCredential;
        if (oauthCredentialMissing) {
          result.counts.oauthMissingCredentials += 1;
          issueIntegrationIds.add(integrationId);
        }
        const patCredentialMissing =
          metadata.auth_type === 'pat' && Boolean(metadata.access_token) && !patCredential;
        if (patCredentialMissing) {
          result.counts.patMissingCredentials += 1;
          issueIntegrationIds.add(integrationId);
        }
        const hasPrimaryLegacyMaterial = Boolean(
          metadata.access_token ||
          metadata.refresh_token ||
          metadata.token_expires_at ||
          metadata.client_secret
        );
        const hasSelfHostedClientCredential =
          metadata.client_id !== undefined || metadata.client_secret !== undefined;
        const selfHostedClientCredentialIsUnmappable =
          hasSelfHostedClientCredential &&
          (metadata.auth_type !== 'oauth' ||
            (metadata.client_id === undefined) !== (metadata.client_secret === undefined));
        const primaryLegacyMaterialIsUnmappable =
          hasPrimaryLegacyMaterial &&
          (selfHostedClientCredentialIsUnmappable ||
            metadata.auth_type === undefined ||
            (metadata.auth_type === 'oauth' &&
              (!metadata.access_token ||
                !metadata.refresh_token ||
                !integration.platform_account_id ||
                !integration.platform_account_login)) ||
            (metadata.auth_type === 'pat' && !metadata.access_token));
        if (primaryLegacyMaterialIsUnmappable) {
          result.counts.unmappableLegacyEntries += 1;
          issueIntegrationIds.add(integrationId);
        }
        const missingProjectCredentialIds = Object.keys(projectTokens).filter(
          projectId => !projectCredentialIds.has(projectId)
        );
        result.counts.projectMissingCredentials += missingProjectCredentialIds.length;
        if (missingProjectCredentialIds.length > 0) issueIntegrationIds.add(integrationId);
        const integrationTypeDisagrees =
          metadata.auth_type !== undefined && metadata.auth_type !== integration.integration_type;
        if (integrationTypeDisagrees) {
          result.counts.integrationTypeDisagreements += 1;
          issueIntegrationIds.add(integrationId);
        }

        if (mode === 'backfill' && mutationsEnabled) {
          const hasConflictingPrimary =
            (metadata.auth_type === 'oauth' && patCredential !== undefined) ||
            (metadata.auth_type === 'pat' && oauthCredential !== undefined);
          if (hasConflictingPrimary || (oauthCredential && patCredential)) return false;
          const backfill = await backfillMissingGitLabCredentials(tx, integration, metadata, {
            oauth: oauthCredential,
            primaryAccess: patCredential,
            access: accessCredentials,
          });
          result.counts.unmappableLegacyEntries += backfill.unmappableProjects;
          if (backfill.unmappableProjects > 0) issueIntegrationIds.add(integrationId);
          return backfill.mutated;
        }
        if (mode === 'scrub' && mutationsEnabled) {
          if (
            credentialAudit.profileMismatches > 0 ||
            credentialAudit.providerMetadataMismatches > 0 ||
            (oauthCredential !== undefined && patCredential !== undefined) ||
            oauthCredentialMissing ||
            patCredentialMissing ||
            primaryLegacyMaterialIsUnmappable ||
            missingProjectCredentialIds.length > 0 ||
            integrationTypeDisagrees
          ) {
            throw new Error('GitLab credential scrub blocked by locked public audit');
          }
          const primaryCredential =
            metadata.auth_type === 'oauth'
              ? oauthCredential
              : metadata.auth_type === 'pat'
                ? patCredential
                : undefined;
          const projectCredentialsComplete = Object.keys(projectTokens).every(projectId =>
            projectCredentialIds.has(projectId)
          );
          const deleteKeys: string[] = [];
          if (primaryCredential) {
            for (const key of [
              'access_token',
              'refresh_token',
              'token_expires_at',
              'client_secret',
            ]) {
              if (key in rawMetadata) deleteKeys.push(key);
            }
          }
          if (projectCredentialsComplete && 'project_tokens' in rawMetadata) {
            deleteKeys.push('project_tokens');
          }
          if (deleteKeys.length === 0) return false;
          await mutateGitLabMetadataInTransaction(tx, integrationId, { delete: deleteKeys });
          return true;
        }
        return false;
      });
      if (mutated) result.mutatedIntegrations += 1;
    }

    cursor = batch.at(-1)?.id;
  }

  result.integrationIds = [...issueIntegrationIds].sort();
  return result;
}
