import 'server-only';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type GitLabMetadataPatch = {
  set?: Record<string, unknown>;
  delete?: readonly string[];
};

type GitLabMetadataPatchInput =
  | GitLabMetadataPatch
  | ((currentMetadata: Readonly<Record<string, unknown>>) => GitLabMetadataPatch);

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('GitLab integration metadata must be an object');
  }
  return { ...metadata };
}

/** Acquires the GitLab integration lifecycle lock and returns freshly read metadata. */
export async function readGitLabMetadataInTransaction(
  tx: DrizzleTransaction,
  integrationId: string
): Promise<Record<string, unknown>> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gitlab-integration:${integrationId}`}, 0))`
  );

  const [integration] = await tx
    .select({ metadata: platform_integrations.metadata })
    .from(platform_integrations)
    .where(
      and(eq(platform_integrations.id, integrationId), eq(platform_integrations.platform, 'gitlab'))
    )
    .limit(1);

  if (!integration) {
    throw new Error('GitLab integration not found');
  }

  return parseMetadata(integration.metadata);
}

/**
 * Applies a GitLab metadata patch while holding the integration lifecycle lock.
 * Callers must supply the transaction that contains their related integration writes.
 */
export async function mutateGitLabMetadataInTransaction(
  tx: DrizzleTransaction,
  integrationId: string,
  patchInput: GitLabMetadataPatchInput
): Promise<Record<string, unknown>> {
  const currentMetadata = await readGitLabMetadataInTransaction(tx, integrationId);
  const patch = typeof patchInput === 'function' ? patchInput(currentMetadata) : patchInput;
  const updatedMetadata = { ...currentMetadata, ...patch.set };
  for (const key of patch.delete ?? []) {
    delete updatedMetadata[key];
  }

  await tx
    .update(platform_integrations)
    .set({
      metadata: updatedMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(eq(platform_integrations.id, integrationId), eq(platform_integrations.platform, 'gitlab'))
    );

  return updatedMetadata;
}
