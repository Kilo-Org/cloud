import 'server-only';

import { db } from '@/lib/drizzle';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { auditGitLabCredentialProfiles } from './credential-migration-audit';
import { backfillMissingGitLabCredentials } from './credential-migration-backfill';
import {
  GitLabLegacyMetadataSchema,
  resolveGitLabCredentialAuthType,
} from './credential-migration-legacy';
import {
  selectGitLabIntegrationsNeedingBackfill,
  selectGitLabIntegrationsNeedingScrub,
} from './credential-migration-selection';
import { normalizeGitLabInstanceUrl } from './instance-url';
import {
  mutateGitLabMetadataInTransaction,
  readGitLabMetadataInTransaction,
} from './metadata-mutation';

export type GitLabBackfillOutcome = {
  /** An encrypted credential row was created for this integration. */
  mutated: boolean;
};

export type GitLabScrubOutcome = {
  /** Legacy plaintext was removed from this integration's metadata. */
  scrubbed: boolean;
  /** The integration was left untouched because it is not safe to scrub yet. */
  skipped: boolean;
};

export type GitLabBackfillBatchResult = {
  processed: number;
  mutated: number;
  unmappable: number;
  nextCursor: string | null;
};

export type GitLabScrubBatchResult = {
  processed: number;
  scrubbed: number;
  skipped: number;
  nextCursor: string | null;
};

function ownerIsAmbiguous(integration: {
  owned_by_user_id: unknown;
  owned_by_organization_id: unknown;
}) {
  return Boolean(integration.owned_by_user_id) === Boolean(integration.owned_by_organization_id);
}

/**
 * Idempotently create the encrypted credential rows for one GitLab integration.
 * Safe to re-run: `backfillMissingGitLabCredentials` inserts with
 * `onConflictDoNothing`, so an already-migrated integration is a no-op. Rows that
 * cannot be mapped (malformed metadata, ambiguous owner, bad instance URL,
 * conflicting primary credentials) are reported as `unmappable` and skipped.
 */
export async function backfillGitLabIntegration(
  integrationId: string
): Promise<GitLabBackfillOutcome> {
  return db.transaction(async tx => {
    let rawMetadata: Record<string, unknown>;
    try {
      rawMetadata = await readGitLabMetadataInTransaction(tx, integrationId);
    } catch {
      return { mutated: false };
    }
    const parsed = GitLabLegacyMetadataSchema.safeParse(rawMetadata);
    if (!parsed.success) return { mutated: false };
    const metadata = parsed.data;

    const [integration] = await tx
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integrationId))
      .limit(1);
    if (!integration) throw new Error('GitLab integration not found');
    if (ownerIsAmbiguous(integration)) return { mutated: false };
    const authType = resolveGitLabCredentialAuthType(metadata, integration);

    try {
      normalizeGitLabInstanceUrl(metadata.gitlab_instance_url);
    } catch {
      return { mutated: false };
    }

    const [oauthCredential] = await tx
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integrationId))
      .limit(1);
    const [primaryAccess] = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integrationId),
          isNull(platform_access_token_credentials.provider_resource_id)
        )
      )
      .limit(1);
    const access = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integrationId));

    const hasConflictingPrimary =
      (authType === 'oauth' && primaryAccess !== undefined) ||
      (authType === 'pat' && oauthCredential !== undefined) ||
      (oauthCredential !== undefined && primaryAccess !== undefined);
    if (hasConflictingPrimary) return { mutated: false };

    const result = await backfillMissingGitLabCredentials(tx, integration, metadata, {
      oauth: oauthCredential,
      primaryAccess,
      access,
    });
    return { mutated: result.mutated };
  });
}

/**
 * Delete legacy plaintext token material from one GitLab integration's metadata.
 * Only proceeds when the encrypted rows are complete and well-formed; any doubt
 * (missing rows, profile/metadata mismatches, disagreeing integration type,
 * malformed metadata) leaves the row untouched (`skipped`) rather than risk
 * destroying the only copy of a token. Callers must confirm decryptability
 * (see the private audit) before scrubbing.
 */
export async function scrubGitLabIntegration(integrationId: string): Promise<GitLabScrubOutcome> {
  return db.transaction(async tx => {
    let rawMetadata: Record<string, unknown>;
    try {
      rawMetadata = await readGitLabMetadataInTransaction(tx, integrationId);
    } catch {
      return { scrubbed: false, skipped: true };
    }
    const parsed = GitLabLegacyMetadataSchema.safeParse(rawMetadata);
    if (!parsed.success) return { scrubbed: false, skipped: true };
    const metadata = parsed.data;

    const [integration] = await tx
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integrationId))
      .limit(1);
    if (!integration) throw new Error('GitLab integration not found');
    if (ownerIsAmbiguous(integration)) return { scrubbed: false, skipped: true };
    const authType = resolveGitLabCredentialAuthType(metadata, integration);

    let providerBaseUrl: string;
    try {
      providerBaseUrl = normalizeGitLabInstanceUrl(metadata.gitlab_instance_url);
    } catch {
      return { scrubbed: false, skipped: true };
    }

    const [oauthCredential] = await tx
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integrationId))
      .limit(1);
    const [primaryAccess] = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integrationId),
          isNull(platform_access_token_credentials.provider_resource_id)
        )
      )
      .limit(1);
    const access = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integrationId));

    const credentialAudit = auditGitLabCredentialProfiles(
      integration,
      providerBaseUrl,
      oauthCredential,
      access
    );
    const projectTokens = metadata.project_tokens ?? {};
    const projectCredentialIds = new Set(
      access.flatMap(row =>
        row.provider_credential_type === 'project_access_token' && row.provider_resource_id !== null
          ? [row.provider_resource_id]
          : []
      )
    );
    const oauthMissing = authType === 'oauth' && Boolean(metadata.access_token) && !oauthCredential;
    const patMissing = authType === 'pat' && Boolean(metadata.access_token) && !primaryAccess;
    const missingProjectIds = Object.keys(projectTokens).filter(
      id => !projectCredentialIds.has(id)
    );
    const integrationTypeDisagrees =
      metadata.auth_type !== undefined && metadata.auth_type !== integration.integration_type;
    const hasPrimaryLegacyMaterial = Boolean(
      metadata.access_token ||
      metadata.refresh_token ||
      metadata.token_expires_at ||
      metadata.client_secret
    );
    const refreshTokenMissingEncryptedCopy =
      metadata.refresh_token !== undefined &&
      (authType !== 'oauth' || !oauthCredential?.refresh_token_encrypted);
    const clientSecretMissingEncryptedCopy =
      metadata.client_secret !== undefined &&
      (authType !== 'oauth' || !oauthCredential?.oauth_client_secret_encrypted);

    const unsafeToScrub =
      credentialAudit.profileMismatches > 0 ||
      credentialAudit.providerMetadataMismatches > 0 ||
      (oauthCredential !== undefined && primaryAccess !== undefined) ||
      oauthMissing ||
      patMissing ||
      missingProjectIds.length > 0 ||
      integrationTypeDisagrees ||
      (hasPrimaryLegacyMaterial && authType === undefined) ||
      refreshTokenMissingEncryptedCopy ||
      clientSecretMissingEncryptedCopy;
    if (unsafeToScrub) return { scrubbed: false, skipped: true };

    const primaryCredential =
      authType === 'oauth' ? oauthCredential : authType === 'pat' ? primaryAccess : undefined;
    const deleteKeys: string[] = [];
    if (primaryCredential) {
      if ('access_token' in rawMetadata) deleteKeys.push('access_token');
      if ('token_expires_at' in rawMetadata) deleteKeys.push('token_expires_at');
      if (
        authType === 'oauth' &&
        oauthCredential?.refresh_token_encrypted &&
        'refresh_token' in rawMetadata
      ) {
        deleteKeys.push('refresh_token');
      }
      if (
        authType === 'oauth' &&
        oauthCredential?.oauth_client_secret_encrypted &&
        'client_secret' in rawMetadata
      ) {
        deleteKeys.push('client_secret');
      }
    }
    if ('project_tokens' in rawMetadata) deleteKeys.push('project_tokens');
    if (deleteKeys.length === 0) return { scrubbed: false, skipped: true };

    await mutateGitLabMetadataInTransaction(tx, integrationId, { delete: deleteKeys });
    return { scrubbed: true, skipped: false };
  });
}

/** Backfill one keyset page of integrations that still need encrypted rows. */
export async function backfillGitLabCredentialBatch(input: {
  limit: number;
  afterId: string | null;
}): Promise<GitLabBackfillBatchResult> {
  const ids = await selectGitLabIntegrationsNeedingBackfill(input.limit, input.afterId);
  let mutated = 0;
  for (const id of ids) {
    const outcome = await backfillGitLabIntegration(id);
    if (outcome.mutated) mutated += 1;
  }
  return {
    processed: ids.length,
    mutated,
    // Every id came from the "needs backfill" query, so a row that did not
    // mutate is one backfill could not advance (unmappable/conflicting/malformed).
    unmappable: ids.length - mutated,
    nextCursor: ids.length === input.limit ? (ids.at(-1) ?? null) : null,
  };
}

/** Scrub one keyset page of fully-backfilled integrations. */
export async function scrubGitLabCredentialBatch(input: {
  limit: number;
  afterId: string | null;
}): Promise<GitLabScrubBatchResult> {
  const ids = await selectGitLabIntegrationsNeedingScrub(input.limit, input.afterId);
  let scrubbed = 0;
  let skipped = 0;
  for (const id of ids) {
    const outcome = await scrubGitLabIntegration(id);
    if (outcome.scrubbed) scrubbed += 1;
    if (outcome.skipped) skipped += 1;
  }
  return {
    processed: ids.length,
    scrubbed,
    skipped,
    nextCursor: ids.length === input.limit ? (ids.at(-1) ?? null) : null,
  };
}
