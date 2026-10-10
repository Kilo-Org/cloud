import 'server-only';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type GiteaMetadataPatch = {
  set?: Record<string, unknown>;
  delete?: readonly string[];
};

type GiteaMetadataPatchInput =
  | GiteaMetadataPatch
  | ((currentMetadata: Readonly<Record<string, unknown>>) => GiteaMetadataPatch);

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Gitea integration metadata must be an object');
  }
  return { ...metadata };
}

/** Acquires the Gitea integration lifecycle lock and returns freshly read metadata. */
export async function readGiteaMetadataInTransaction(
  tx: DrizzleTransaction,
  integrationId: string
): Promise<Record<string, unknown>> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gitea-integration:'}${integrationId}, 0))`
  );

  const [integration] = await tx
    .select({ metadata: platform_integrations.metadata })
    .from(platform_integrations)
    .where(
      and(eq(platform_integrations.id, integrationId), eq(platform_integrations.platform, 'gitea'))
    )
    .limit(1);

  if (!integration) {
    throw new Error('Gitea integration not found');
  }

  return parseMetadata(integration.metadata);
}

/**
 * Applies a Gitea metadata patch while holding the integration lifecycle lock.
 * Callers must supply the transaction that contains their related integration writes.
 */
export async function mutateGiteaMetadataInTransaction(
  tx: DrizzleTransaction,
  integrationId: string,
  patchInput: GiteaMetadataPatchInput
): Promise<Record<string, unknown>> {
  const currentMetadata = await readGiteaMetadataInTransaction(tx, integrationId);
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
      and(eq(platform_integrations.id, integrationId), eq(platform_integrations.platform, 'gitea'))
    );

  return updatedMetadata;
}
