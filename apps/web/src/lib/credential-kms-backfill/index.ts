import 'server-only';

import {
  and,
  asc,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import pLimit from 'p-limit';
import { coding_plan_key_inventory, openai_chatgpt_connections } from '@kilocode/db/schema';
import type { EncryptedData } from '@kilocode/db/schema-types';
import { sanitizedExceptionName } from '@kilocode/worker-utils/scheduled-job-observability';
import {
  envelopeForStoredLegacyCiphertext,
  legacyCiphertextDigestSql,
} from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  getByokKmsClientConfig,
  type ByokDataKey,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import {
  createOpenAiChatGptSealingKey,
  openAiChatGptKmsOwnerOfRow,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/connection-encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCodingPlanInventoryDataKey } from '@/lib/coding-plans/inventory-credential-encryption';

/** Recorded by the KMS service as the actor of every data key this backfill creates. */
export const CREDENTIAL_KMS_BACKFILL_ACTOR = 'system:credential-kms-backfill';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 5;

export type CredentialKmsBackfillStoreName = 'coding_plan_inventory' | 'openai_chatgpt_connections';

/** Why a row could not be migrated. Only these categories are reported, never the error. */
type FailureCategory = 'legacy_unreadable' | 'kms' | 'database';

export type CredentialKmsBackfillStoreSummary = {
  store: CredentialKmsBackfillStoreName;
  scanned: number;
  migrated: number;
  /** Rows another writer changed between the read and the write; the next run retries them. */
  skippedConcurrentWrite: number;
  /**
   * Envelopes removed because their static-key credential was cleared: a revocation by the
   * previous deployment during a rollback clears only the static-key column.
   */
  clearedOrphanedEnvelopes: number;
  failed: Record<FailureCategory, number>;
  /**
   * Rows still without a current envelope, counted after the work. Null when the count
   * itself failed, which is unknown rather than zero.
   */
  remaining: number | null;
  /** True when the pass reached the last candidate row instead of stopping at the deadline. */
  reachedEnd: boolean;
  /** The sanitized name of an error that stopped this store's pass, if any. */
  errorName: string | null;
};

/**
 * Rows the backfill has to give an envelope: the static-key credential is present and no
 * envelope was written together with it. That covers rows written before the rollout and
 * rows the previous deployment rewrote after a rollback, whose envelope is stale.
 */
function needsEnvelope(legacy: AnyColumn, envelope: AnyColumn): SQL {
  return and(
    isNotNull(legacy),
    or(
      isNull(envelope),
      sql`(${envelope} ->> 'legacy_digest') IS DISTINCT FROM ${legacyCiphertextDigestSql(legacy)}`
    )
  ) as SQL;
}

/** Sealed with a step so a failure is reported by category, never by its message. */
class BackfillStepError extends Error {
  constructor(readonly category: FailureCategory) {
    super(`credential KMS backfill ${category} failure`);
    this.name = 'BackfillStepError';
  }
}

function openLegacyCiphertext(legacy: EncryptedData): string {
  try {
    return decryptApiKey(legacy, BYOK_ENCRYPTION_KEY);
  } catch {
    throw new BackfillStepError('legacy_unreadable');
  }
}

async function createDataKey<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch {
    throw new BackfillStepError('kms');
  }
}

type BackfillRow = { id: string };

type CredentialStore<Row extends BackfillRow> = {
  name: CredentialKmsBackfillStoreName;
  /** Rows still needing work: an envelope to create, or an orphaned one to remove. */
  countRemaining(): Promise<number>;
  /** Removes envelopes whose credential was cleared, returning how many. */
  clearOrphanedEnvelopes?(): Promise<number>;
  selectBatch(afterId: string | null, limit: number): Promise<Row[]>;
  /** Writes the row's envelope unless another writer changed the row since it was read. */
  migrateRow(row: Row): Promise<'migrated' | 'skipped'>;
};

// The backfill leaves the credential's last-modified time alone: the credential did not change.
const keepInventoryUpdatedAt = sql`${coding_plan_key_inventory.updated_at}`;
const keepConnectionUpdatedAt = sql`${openai_chatgpt_connections.updated_at}`;

const inventoryNeedsEnvelope = needsEnvelope(
  coding_plan_key_inventory.encrypted_api_key,
  coding_plan_key_inventory.encrypted_api_key_envelope
);

/**
 * A cleared credential whose envelope survived. Every writer of this deployment clears both
 * columns together, so only the previous deployment leaves this state behind; readers
 * already treat the row as having no credential, and Coding Plans 4.7 requires the
 * encrypted material itself to go.
 */
const inventoryHasOrphanedEnvelope = and(
  isNull(coding_plan_key_inventory.encrypted_api_key),
  isNotNull(coding_plan_key_inventory.encrypted_api_key_envelope)
) as SQL;

type InventoryRow = { id: string; encrypted_api_key: EncryptedData | null };

const codingPlanInventoryStore: CredentialStore<InventoryRow> = {
  name: 'coding_plan_inventory',
  async countRemaining() {
    const [row] = await db
      .select({ remaining: count() })
      .from(coding_plan_key_inventory)
      .where(or(inventoryNeedsEnvelope, inventoryHasOrphanedEnvelope));
    return row?.remaining ?? 0;
  },
  async clearOrphanedEnvelopes() {
    // One statement: a row a writer gives a credential again in the meantime no longer
    // matches, and removing an envelope can never restore a credential.
    const cleared = await db
      .update(coding_plan_key_inventory)
      .set({ encrypted_api_key_envelope: null, updated_at: keepInventoryUpdatedAt })
      .where(inventoryHasOrphanedEnvelope)
      .returning({ id: coding_plan_key_inventory.id });
    return cleared.length;
  },
  async selectBatch(afterId, limit) {
    return await db
      .select({
        id: coding_plan_key_inventory.id,
        encrypted_api_key: coding_plan_key_inventory.encrypted_api_key,
      })
      .from(coding_plan_key_inventory)
      .where(
        and(
          inventoryNeedsEnvelope,
          afterId === null ? undefined : gt(coding_plan_key_inventory.id, afterId)
        )
      )
      .orderBy(asc(coding_plan_key_inventory.id))
      .limit(limit);
  },
  async migrateRow(row) {
    const legacy = row.encrypted_api_key;
    if (!legacy) return 'skipped';
    const plaintext = openLegacyCiphertext(legacy);
    const dataKey: ByokDataKey = await createDataKey(() =>
      createCodingPlanInventoryDataKey(row.id, CREDENTIAL_KMS_BACKFILL_ACTOR)
    );
    const updated = await db
      .update(coding_plan_key_inventory)
      .set({
        encrypted_api_key_envelope: envelopeForStoredLegacyCiphertext(plaintext, legacy, dataKey),
        updated_at: keepInventoryUpdatedAt,
      })
      .where(
        and(
          eq(coding_plan_key_inventory.id, row.id),
          inventoryNeedsEnvelope,
          // The envelope holds the credential read above. A replacement, revocation or
          // writer of either deployment since then changed this ciphertext, and writing
          // the envelope would restore the credential it replaced or removed.
          sql`${coding_plan_key_inventory.encrypted_api_key} = ${JSON.stringify(legacy)}::jsonb`
        )
      )
      .returning({ id: coding_plan_key_inventory.id });
    return updated.length > 0 ? 'migrated' : 'skipped';
  },
};

/**
 * A member row whose person was hard-deleted has no owner left to bind its data key to.
 * Nobody can read it, so it is not migrated and not counted as remaining.
 */
const connectionHasOwner = or(
  eq(openai_chatgpt_connections.is_shared_services, true),
  isNotNull(openai_chatgpt_connections.kilo_user_id)
) as SQL;

const connectionNeedsEnvelope = and(
  connectionHasOwner,
  needsEnvelope(
    openai_chatgpt_connections.encrypted_connection,
    openai_chatgpt_connections.encrypted_connection_envelope
  )
) as SQL;

type ConnectionRow = {
  id: string;
  encrypted_connection: EncryptedData;
  kilo_user_id: string | null;
  organization_id: string | null;
  is_shared_services: boolean;
};

function sameNullableText(column: AnyColumn, value: string | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

const openAiChatGptConnectionsStore: CredentialStore<ConnectionRow> = {
  name: 'openai_chatgpt_connections',
  async countRemaining() {
    const [row] = await db
      .select({ remaining: count() })
      .from(openai_chatgpt_connections)
      .where(connectionNeedsEnvelope);
    return row?.remaining ?? 0;
  },
  async selectBatch(afterId, limit) {
    return await db
      .select({
        id: openai_chatgpt_connections.id,
        encrypted_connection: openai_chatgpt_connections.encrypted_connection,
        kilo_user_id: openai_chatgpt_connections.kilo_user_id,
        organization_id: openai_chatgpt_connections.organization_id,
        is_shared_services: openai_chatgpt_connections.is_shared_services,
      })
      .from(openai_chatgpt_connections)
      .where(
        and(
          connectionNeedsEnvelope,
          afterId === null ? undefined : gt(openai_chatgpt_connections.id, afterId)
        )
      )
      .orderBy(asc(openai_chatgpt_connections.id))
      .limit(limit);
  },
  async migrateRow(row) {
    const owner = openAiChatGptKmsOwnerOfRow(row);
    if (!owner) return 'skipped';
    const legacy = row.encrypted_connection;
    const plaintext = openLegacyCiphertext(legacy);
    const sealingKey = await createDataKey(() =>
      createOpenAiChatGptSealingKey(owner, CREDENTIAL_KMS_BACKFILL_ACTOR)
    );
    const updated = await db
      .update(openai_chatgpt_connections)
      .set({
        encrypted_connection_envelope: {
          ...envelopeForStoredLegacyCiphertext(plaintext, legacy, sealingKey.dataKey),
          key_id: sealingKey.keyId,
        },
        updated_at: keepConnectionUpdatedAt,
      })
      .where(
        and(
          eq(openai_chatgpt_connections.id, row.id),
          connectionNeedsEnvelope,
          // A token refresh, reconnect, refusal or terminal failure since the read rewrote
          // this ciphertext; writing the envelope would bring back the tokens it replaced.
          sql`${openai_chatgpt_connections.encrypted_connection} = ${JSON.stringify(legacy)}::jsonb`,
          // The data key is bound to the owner read above.
          sameNullableText(openai_chatgpt_connections.kilo_user_id, row.kilo_user_id),
          sameNullableText(openai_chatgpt_connections.organization_id, row.organization_id),
          eq(openai_chatgpt_connections.is_shared_services, row.is_shared_services)
        )
      )
      .returning({ id: openai_chatgpt_connections.id });
    return updated.length > 0 ? 'migrated' : 'skipped';
  },
};

function emptySummary(store: CredentialKmsBackfillStoreName): CredentialKmsBackfillStoreSummary {
  return {
    store,
    scanned: 0,
    migrated: 0,
    skippedConcurrentWrite: 0,
    clearedOrphanedEnvelopes: 0,
    failed: { legacy_unreadable: 0, kms: 0, database: 0 },
    remaining: null,
    reachedEnd: false,
    errorName: null,
  };
}

async function backfillStore<Row extends BackfillRow>(
  store: CredentialStore<Row>,
  { deadlineAt, batchSize, concurrency }: BackfillOptions
): Promise<CredentialKmsBackfillStoreSummary> {
  const summary = emptySummary(store.name);
  try {
    // Removing an orphaned envelope needs no data key, so it runs even without KMS.
    if (store.clearOrphanedEnvelopes) {
      summary.clearedOrphanedEnvelopes = await store.clearOrphanedEnvelopes();
    }

    // An unconfigured KMS service would fail every row; fail the pass once instead.
    getByokKmsClientConfig();

    let afterId: string | null = null;
    const limit = pLimit(concurrency);
    while (Date.now() < deadlineAt) {
      const rows = await store.selectBatch(afterId, batchSize);
      if (rows.length === 0) {
        summary.reachedEnd = true;
        break;
      }
      // Keyset paging past this batch: a row that keeps failing cannot starve the ones after it.
      afterId = rows[rows.length - 1].id;

      await Promise.all(
        rows.map(row =>
          limit(async () => {
            if (Date.now() >= deadlineAt) return;
            summary.scanned += 1;
            try {
              if ((await store.migrateRow(row)) === 'migrated') summary.migrated += 1;
              else summary.skippedConcurrentWrite += 1;
            } catch (error) {
              summary.failed[error instanceof BackfillStepError ? error.category : 'database'] += 1;
            }
          })
        )
      );
      if (rows.length < batchSize) {
        summary.reachedEnd = Date.now() < deadlineAt;
        break;
      }
    }
  } catch (error) {
    summary.errorName = sanitizedExceptionName(error);
  }

  // Counted after the work, so rows this run migrated are not in the figure.
  try {
    summary.remaining = await store.countRemaining();
  } catch (error) {
    summary.errorName ??= sanitizedExceptionName(error);
  }
  return summary;
}

type BackfillOptions = {
  /** Epoch ms after which no further row is started. */
  deadlineAt: number;
  batchSize: number;
  concurrency: number;
};

/**
 * Gives every Coding Plan inventory credential and ChatGPT connection payload that has no
 * current KMS envelope one. The static-key ciphertext is left as it is, so the previous
 * deployment can still read every row after a rollback.
 *
 * Safe to run repeatedly and from overlapping invocations: a row is only written while it
 * still needs an envelope and still holds the ciphertext the envelope was built from, so a
 * concurrent token refresh, replacement or revocation wins and the row is retried, if still
 * needed, on the next run. Once every row is migrated a run is two counting queries per store.
 *
 * The first store may use half of the time budget, so the second always gets a turn.
 */
export async function backfillCredentialKmsEnvelopes({
  deadlineAt,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
}: {
  deadlineAt: number;
  batchSize?: number;
  concurrency?: number;
}): Promise<CredentialKmsBackfillStoreSummary[]> {
  const startedAt = Date.now();
  const firstDeadline = startedAt + Math.max(0, deadlineAt - startedAt) / 2;
  return [
    await backfillStore(codingPlanInventoryStore, {
      deadlineAt: firstDeadline,
      batchSize,
      concurrency,
    }),
    await backfillStore(openAiChatGptConnectionsStore, { deadlineAt, batchSize, concurrency }),
  ];
}
