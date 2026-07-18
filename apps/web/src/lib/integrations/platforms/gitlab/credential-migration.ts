import 'server-only';

import { db } from '@/lib/drizzle';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
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

export type GitLabCredentialMigrationBatch = {
  nextCursor: string | null;
  complete: boolean;
  scannedIntegrations: number;
  mutatedIntegrations: number;
  counts: GitLabCredentialAuditCounts;
  issueIntegrationIds: string[];
};

export type ProcessGitLabCredentialMigrationBatchOptions = {
  mode: GitLabCredentialMigrationMode;
  afterIntegrationId?: string | null;
  batchSize: number;
  apply: boolean;
  assertLease?: () => Promise<boolean>;
};

export class GitLabCredentialMigrationLeaseLostError extends Error {
  constructor() {
    super('GitLab credential migration lease was lost');
  }
}

function addCounts(target: GitLabCredentialAuditCounts, delta: GitLabCredentialAuditCounts) {
  for (const key of Object.keys(target) as Array<keyof GitLabCredentialAuditCounts>) {
    target[key] += delta[key];
  }
}

async function auditOrphanedCredentials(): Promise<GitLabCredentialAuditCounts> {
  const counts = emptyGitLabCredentialAuditCounts();
  // Only count credentials whose parent integration is gone. Other platforms
  // (e.g. Bitbucket) legitimately share these tables and must not block the gate.
  const [oauth] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(platform_oauth_credentials)
    .leftJoin(
      platform_integrations,
      eq(platform_integrations.id, platform_oauth_credentials.platform_integration_id)
    )
    .where(isNull(platform_integrations.id));
  const [access] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(platform_access_token_credentials)
    .leftJoin(
      platform_integrations,
      eq(platform_integrations.id, platform_access_token_credentials.platform_integration_id)
    )
    .where(isNull(platform_integrations.id));
  counts.credentialProfileMismatches = (oauth?.count ?? 0) + (access?.count ?? 0);
  return counts;
}

export async function processGitLabCredentialMigrationBatch(
  options: ProcessGitLabCredentialMigrationBatchOptions
): Promise<GitLabCredentialMigrationBatch> {
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new Error('GitLab credential migration batch size must be a positive integer');
  }

  const counts = emptyGitLabCredentialAuditCounts();
  const issueIntegrationIds = new Set<string>();
  const batch = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      options.afterIntegrationId
        ? and(
            eq(platform_integrations.platform, 'gitlab'),
            gt(platform_integrations.id, options.afterIntegrationId)
          )
        : eq(platform_integrations.platform, 'gitlab')
    )
    .orderBy(asc(platform_integrations.id))
    .limit(options.batchSize + 1);
  const hasMore = batch.length > options.batchSize;
  const integrations = hasMore ? batch.slice(0, options.batchSize) : batch;
  let mutatedIntegrations = 0;

  for (const { id: integrationId } of integrations) {
    if (options.assertLease && !(await options.assertLease())) {
      throw new GitLabCredentialMigrationLeaseLostError();
    }
    const mutated = await db.transaction(async tx => {
      let rawMetadata: Record<string, unknown>;
      try {
        rawMetadata = await readGitLabMetadataInTransaction(tx, integrationId);
      } catch {
        if (options.mode === 'scrub' && options.apply) {
          throw new Error('GitLab credential scrub blocked by locked public audit');
        }
        counts.malformedMetadata += 1;
        counts.unmappableLegacyEntries += 1;
        issueIntegrationIds.add(integrationId);
        return false;
      }
      counts.legacySecretFields += countLegacySecretFields(rawMetadata);
      if (hasTokenBearingLegacyMetadata(rawMetadata)) counts.legacyTokenBearingIntegrations += 1;
      const metadataResult = GitLabLegacyMetadataSchema.safeParse(rawMetadata);
      if (!metadataResult.success) {
        if (options.mode === 'scrub' && options.apply) {
          throw new Error('GitLab credential scrub blocked by locked public audit');
        }
        counts.malformedMetadata += 1;
        counts.unmappableLegacyEntries += 1;
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
      if (Boolean(integration.owned_by_user_id) === Boolean(integration.owned_by_organization_id)) {
        counts.unmappableLegacyEntries += 1;
        issueIntegrationIds.add(integrationId);
        return false;
      }
      let providerBaseUrl: string;
      try {
        providerBaseUrl = normalizeGitLabInstanceUrl(metadata.gitlab_instance_url);
      } catch {
        if (options.mode === 'scrub' && options.apply) {
          throw new Error('GitLab credential scrub blocked by locked public audit');
        }
        counts.malformedMetadata += 1;
        counts.unmappableLegacyEntries += 1;
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
      counts.credentialProfileMismatches += credentialAudit.profileMismatches;
      counts.providerMetadataMismatches += credentialAudit.providerMetadataMismatches;
      if (credentialAudit.profileMismatches > 0 || credentialAudit.providerMetadataMismatches > 0) {
        issueIntegrationIds.add(integrationId);
      }
      if (oauthCredential && patCredential) {
        counts.crossTablePrimaryCredentialDuplicates += 1;
        issueIntegrationIds.add(integrationId);
      }
      const oauthCredentialMissing =
        metadata.auth_type === 'oauth' && Boolean(metadata.access_token) && !oauthCredential;
      if (oauthCredentialMissing) {
        counts.oauthMissingCredentials += 1;
        issueIntegrationIds.add(integrationId);
      }
      const patCredentialMissing =
        metadata.auth_type === 'pat' && Boolean(metadata.access_token) && !patCredential;
      if (patCredentialMissing) {
        counts.patMissingCredentials += 1;
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
        counts.unmappableLegacyEntries += 1;
        issueIntegrationIds.add(integrationId);
      }
      const missingProjectCredentialIds = Object.keys(projectTokens).filter(
        projectId => !projectCredentialIds.has(projectId)
      );
      counts.projectMissingCredentials += missingProjectCredentialIds.length;
      if (missingProjectCredentialIds.length > 0) issueIntegrationIds.add(integrationId);
      const integrationTypeDisagrees =
        metadata.auth_type !== undefined && metadata.auth_type !== integration.integration_type;
      if (integrationTypeDisagrees) {
        counts.integrationTypeDisagreements += 1;
        issueIntegrationIds.add(integrationId);
      }

      if (options.mode === 'backfill' && options.apply) {
        const hasConflictingPrimary =
          (metadata.auth_type === 'oauth' && patCredential !== undefined) ||
          (metadata.auth_type === 'pat' && oauthCredential !== undefined);
        if (hasConflictingPrimary || (oauthCredential && patCredential)) return false;
        const backfill = await backfillMissingGitLabCredentials(tx, integration, metadata, {
          oauth: oauthCredential,
          primaryAccess: patCredential,
          access: accessCredentials,
        });
        counts.unmappableLegacyEntries += backfill.unmappableProjects;
        if (backfill.unmappableProjects > 0) issueIntegrationIds.add(integrationId);
        return backfill.mutated;
      }
      if (options.mode === 'scrub' && options.apply) {
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
    if (mutated) mutatedIntegrations += 1;
  }

  if (!hasMore) addCounts(counts, await auditOrphanedCredentials());
  return {
    nextCursor: hasMore ? (integrations.at(-1)?.id ?? null) : null,
    complete: !hasMore,
    scannedIntegrations: integrations.length,
    mutatedIntegrations,
    counts,
    issueIntegrationIds: [...issueIntegrationIds].sort(),
  };
}

export async function runGitLabCredentialMigration(
  options: GitLabCredentialMigrationOptions = {}
): Promise<GitLabCredentialMigrationResult> {
  const mode = options.mode ?? 'audit';
  const batchSize = options.batchSize ?? 100;
  if (mode === 'scrub' && options.apply === true && options.privateAuditPassed !== true) {
    throw new Error('GitLab credential scrub requires a passing private-key audit assertion');
  }
  if (mode === 'scrub' && options.apply === true) {
    const audit = await runGitLabCredentialMigration({ mode: 'audit', batchSize });
    if (hasBlockingGitLabCredentialAuditIssues(audit.counts)) {
      throw new Error('GitLab credential scrub blocked by unresolved public audit issues');
    }
  }
  const result: GitLabCredentialMigrationResult = {
    mode,
    applied: options.apply === true && mode !== 'audit',
    scannedIntegrations: 0,
    mutatedIntegrations: 0,
    counts: emptyGitLabCredentialAuditCounts(),
    integrationIds: [],
  };
  const issueIntegrationIds = new Set<string>();
  let cursor: string | null = null;
  do {
    const batch = await processGitLabCredentialMigrationBatch({
      mode,
      afterIntegrationId: cursor,
      batchSize,
      apply: result.applied,
    });
    result.scannedIntegrations += batch.scannedIntegrations;
    result.mutatedIntegrations += batch.mutatedIntegrations;
    addCounts(result.counts, batch.counts);
    batch.issueIntegrationIds.forEach(id => issueIntegrationIds.add(id));
    cursor = batch.nextCursor;
    if (batch.complete) break;
  } while (cursor);
  result.integrationIds = [...issueIntegrationIds].sort();
  return result;
}
