import { and, desc, eq, gt, gte, lt, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';

import {
  decodeKiloSdkMessagesCursor,
  encodeKiloSdkMessagesCursor,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  messageIdSchema,
  partIdSchema,
  type KiloSdkMessagesCursor,
  type KiloSdkMessagesLegacyCursor,
} from '@kilocode/session-ingest-contracts';

import { ingestItems } from '../db/sqlite-schema';
import { getPartItemIdentityRange } from '../util/compaction';

export const MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES = 8 * 1024 * 1024;
export const MAX_KILO_SDK_SESSION_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const KILO_SDK_HISTORY_CANDIDATE_OVERHEAD_BYTES = 256;
const KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE = 64;
// Bound cold positive-limit scans to two SQLite batches before failing unsafe continuation.
export const KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP =
  2 * KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE;

type KiloSdkHistoryReadPhase = 'message_scan' | 'page_parts';

type KiloSdkHistoryTooLarge = {
  kind: 'too_large';
  maximumBytes: number;
  phase: KiloSdkHistoryReadPhase;
};

type KiloSdkHistoryRetryableFailure = {
  kind: 'retryable_failure';
  phase: KiloSdkHistoryReadPhase;
};

type KiloSdkInvalidData = { kind: 'invalid_data' };
type KiloSdkIntrinsicallyTooLarge = { kind: 'intrinsically_too_large' };
type KiloSdkHistoryReadFailure =
  | KiloSdkHistoryTooLarge
  | KiloSdkHistoryRetryableFailure
  | KiloSdkInvalidData;

export type KiloSdkSessionSnapshotRead =
  | { kind: 'pending' }
  | { kind: 'value'; info: Record<string, unknown>; byteLength: number }
  | { kind: 'too_large'; maximumBytes: number }
  | { kind: 'retryable_failure' }
  | KiloSdkInvalidData;

type KiloSdkMessagesRead =
  | {
      messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>;
      nextCursor: string | null;
      omittedItemCount: number;
    }
  | KiloSdkHistoryReadFailure
  | null;

type KiloSdkHistoryReadBudget = {
  maximumBytes: number;
  consumedBytes: number;
};

export function createKiloSdkHistoryReadBudget(
  maximumBytes = MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES
): KiloSdkHistoryReadBudget {
  return { maximumBytes, consumedBytes: 0 };
}

type ItemDataRef = Pick<typeof ingestItems.$inferSelect, 'item_data' | 'item_data_r2_key'>;

type MaterializedKiloSdkMessage = {
  info: Record<string, unknown>;
  identity: KiloSdkMessagesLegacyCursor;
};

type PersistedKiloSdkMessageStorageIdentity = {
  itemId: string;
  messageId: string;
};

type KiloSdkMessageInfoEnumeration = {
  pageNewestFirst: MaterializedKiloSdkMessage[];
  nextCursor: string | null;
  omittedItemCount: number;
};

type KiloSdkOversizedItemPolicy = 'skip' | 'fail';

type KiloSdkHistoryCandidateRead =
  | { kind: 'value'; value: Record<string, unknown> }
  | { kind: 'missing' }
  | KiloSdkIntrinsicallyTooLarge
  | KiloSdkHistoryReadFailure;

type KiloSdkHistoryCandidateOutcome =
  | { kind: 'skip' }
  | { kind: 'value'; value: Record<string, unknown> }
  | KiloSdkHistoryReadFailure;

export async function readKiloSdkSessionSnapshot(
  db: DrizzleSqliteDODatabase,
  r2: R2Bucket
): Promise<KiloSdkSessionSnapshotRead> {
  const resolveSession = () =>
    db
      .select({
        item_data: ingestItems.item_data,
        item_data_r2_key: ingestItems.item_data_r2_key,
      })
      .from(ingestItems)
      .where(eq(ingestItems.item_type, 'session'))
      .limit(1)
      .get();
  const sessionRow = resolveSession();

  if (!sessionRow) {
    return { kind: 'pending' };
  }

  return readKiloSdkSessionItem(
    sessionRow,
    resolveSession,
    r2,
    MAX_KILO_SDK_SESSION_SNAPSHOT_BYTES
  );
}

export async function readKiloSdkMessages(
  db: DrizzleSqliteDODatabase,
  r2: R2Bucket,
  params: { limit?: number; before?: string }
): Promise<KiloSdkMessagesRead> {
  const budget = createKiloSdkHistoryReadBudget();
  const before =
    params.before === undefined ? undefined : decodeKiloSdkMessagesCursor(params.before);
  const requestedLimit = params.limit ?? 0;
  const limit =
    requestedLimit > 0
      ? Math.min(requestedLimit, MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE)
      : requestedLimit;
  if (limit <= 0 && before !== undefined) {
    return { kind: 'invalid_data' };
  }
  const enumerated =
    limit > 0
      ? await enumerateBoundedKiloSdkMessageInfos(db, r2, budget, limit, before)
      : await enumerateUnboundedKiloSdkMessageInfos(db, r2, budget);
  if (isKiloSdkHistoryReadFailure(enumerated)) {
    return enumerated;
  }

  if (enumerated.pageNewestFirst.length === 0) {
    if (enumerated.omittedItemCount > 0 || enumerated.nextCursor) {
      return {
        messages: [],
        nextCursor: enumerated.nextCursor,
        omittedItemCount: enumerated.omittedItemCount,
      };
    }
    const sessionRow = db
      .select({ id: ingestItems.id })
      .from(ingestItems)
      .where(eq(ingestItems.item_type, 'session'))
      .limit(1)
      .get();
    const messageRow = db
      .select({ id: ingestItems.id })
      .from(ingestItems)
      .where(eq(ingestItems.item_type, 'message'))
      .limit(1)
      .get();
    return sessionRow || messageRow
      ? { messages: [], nextCursor: null, omittedItemCount: 0 }
      : null;
  }
  const storedMessagesNewestFirst: Array<{
    info: Record<string, unknown>;
    parts: Record<string, unknown>[];
  }> = [];
  let omittedItemCount = enumerated.omittedItemCount;
  let partHydrationStopped = false;

  for (const message of enumerated.pageNewestFirst) {
    if (partHydrationStopped) {
      const omittedParts = countKiloSdkMessagePartRows(db, message.identity);
      if (omittedParts.kind === 'invalid_data') {
        return omittedParts;
      }
      omittedItemCount += omittedParts.count;
      storedMessagesNewestFirst.push({ info: message.info, parts: [] });
      continue;
    }
    const hydratedParts = await hydrateKiloSdkMessageParts(
      db,
      r2,
      budget,
      message.identity,
      limit > 0 ? 'skip' : 'fail'
    );
    if (isKiloSdkHistoryReadFailure(hydratedParts)) {
      return hydratedParts;
    }
    omittedItemCount += hydratedParts.omittedItemCount;
    partHydrationStopped = hydratedParts.aggregateBudgetExhausted;
    storedMessagesNewestFirst.push({ info: message.info, parts: hydratedParts.parts });
  }

  return {
    messages: storedMessagesNewestFirst.reverse(),
    nextCursor: enumerated.nextCursor,
    omittedItemCount,
  };
}

function messageItemId(messageId: string): string {
  return `message/${messageId}`;
}

function parsePersistedKiloSdkMessageStorageIdentity(
  itemId: string
): PersistedKiloSdkMessageStorageIdentity | null {
  const prefix = 'message/';
  if (!itemId.startsWith(prefix)) return null;
  const parsed = messageIdSchema.safeParse(itemId.slice(prefix.length));
  return parsed.success && !parsed.data.includes('/') ? { itemId, messageId: parsed.data } : null;
}

function readItemReference(db: DrizzleSqliteDODatabase, rowId: number): ItemDataRef | undefined {
  return db
    .select({ item_data: ingestItems.item_data, item_data_r2_key: ingestItems.item_data_r2_key })
    .from(ingestItems)
    .where(eq(ingestItems.id, rowId))
    .get();
}

function isKiloSdkHistoryReadFailure(
  result: KiloSdkHistoryReadFailure | object
): result is KiloSdkHistoryReadFailure {
  return 'kind' in result;
}

function resolveKiloSdkHistoryCandidateOutcome(
  materialized: KiloSdkHistoryCandidateRead,
  oversizedItemPolicy: KiloSdkOversizedItemPolicy,
  phase: KiloSdkHistoryReadPhase
): KiloSdkHistoryCandidateOutcome {
  if (materialized.kind === 'missing') {
    return { kind: 'skip' };
  }
  if (materialized.kind === 'intrinsically_too_large') {
    return oversizedItemPolicy === 'skip'
      ? { kind: 'skip' }
      : { kind: 'too_large', maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES, phase };
  }
  return materialized;
}

function hasOlderKiloSdkMessageRows(
  db: DrizzleSqliteDODatabase,
  beforeMessageItemId: string
): boolean {
  return Boolean(
    db
      .select({ id: ingestItems.id })
      .from(ingestItems)
      .where(
        and(eq(ingestItems.item_type, 'message'), lt(ingestItems.item_id, beforeMessageItemId))
      )
      .limit(1)
      .get()
  );
}

function finishBoundedKiloSdkMessageInfoEnumeration(
  db: DrizzleSqliteDODatabase,
  pageNewestFirst: MaterializedKiloSdkMessage[],
  omittedItemCount: number,
  lastConsumedMessageStorageIdentity: PersistedKiloSdkMessageStorageIdentity | undefined
): KiloSdkMessageInfoEnumeration | KiloSdkHistoryTooLarge {
  if (
    !lastConsumedMessageStorageIdentity ||
    !hasOlderKiloSdkMessageRows(db, lastConsumedMessageStorageIdentity.itemId)
  ) {
    return { pageNewestFirst, nextCursor: null, omittedItemCount };
  }
  const oldestReturnedMessage = pageNewestFirst[pageNewestFirst.length - 1];
  if (
    !oldestReturnedMessage ||
    messageItemId(oldestReturnedMessage.identity.id) !== lastConsumedMessageStorageIdentity.itemId
  ) {
    return {
      kind: 'too_large',
      maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
      phase: 'message_scan',
    };
  }
  return {
    pageNewestFirst,
    nextCursor: encodeKiloSdkMessagesCursor(oldestReturnedMessage.identity),
    omittedItemCount,
  };
}

async function enumerateBoundedKiloSdkMessageInfos(
  db: DrizzleSqliteDODatabase,
  r2: R2Bucket,
  budget: KiloSdkHistoryReadBudget,
  limit: number,
  before: KiloSdkMessagesCursor | undefined
): Promise<KiloSdkMessageInfoEnumeration | KiloSdkHistoryReadFailure> {
  const pageNewestFirst: MaterializedKiloSdkMessage[] = [];
  let omittedItemCount = 0;
  let consumedRowCount = 0;
  let lastConsumedMessageStorageIdentity: PersistedKiloSdkMessageStorageIdentity | undefined;
  let scanBeforeItemId = before ? messageItemId(before.id) : undefined;
  while (
    pageNewestFirst.length < limit &&
    consumedRowCount < KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP
  ) {
    const pageRows = db
      .select({ id: ingestItems.id, item_id: ingestItems.item_id })
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'message'),
          scanBeforeItemId ? lt(ingestItems.item_id, scanBeforeItemId) : undefined
        )
      )
      .orderBy(desc(ingestItems.item_id))
      .limit(
        Math.min(
          KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE,
          KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP - consumedRowCount
        )
      )
      .all();
    if (pageRows.length === 0) break;
    for (const row of pageRows) {
      const storageIdentity = parsePersistedKiloSdkMessageStorageIdentity(row.item_id);
      if (!storageIdentity) {
        return { kind: 'invalid_data' };
      }
      const materialized = await readKiloSdkHistoryCandidate(
        row.id,
        rowId => readItemReference(db, rowId),
        r2,
        budget,
        'message_scan'
      );
      if (materialized.kind === 'too_large') {
        if (pageNewestFirst.length === 0) {
          return materialized;
        }
        return finishBoundedKiloSdkMessageInfoEnumeration(
          db,
          pageNewestFirst,
          omittedItemCount,
          lastConsumedMessageStorageIdentity
        );
      } else {
        const outcome = resolveKiloSdkHistoryCandidateOutcome(materialized, 'skip', 'message_scan');
        if (outcome.kind === 'skip') {
          if (materialized.kind === 'intrinsically_too_large') {
            const omittedRows = countOmittedKiloSdkMessageRows(db, row.item_id);
            if (omittedRows.kind === 'invalid_data') {
              return omittedRows;
            }
            omittedItemCount += omittedRows.count;
          } else {
            omittedItemCount += 1;
          }
        } else if (outcome.kind !== 'value') {
          return outcome;
        } else {
          const identity = readMessageIdentity(outcome.value);
          if (!identity || identity.id !== storageIdentity.messageId) {
            return { kind: 'invalid_data' };
          }
          pageNewestFirst.push({ info: outcome.value, identity });
        }
      }
      lastConsumedMessageStorageIdentity = storageIdentity;
      scanBeforeItemId = storageIdentity.itemId;
      consumedRowCount += 1;
      if (pageNewestFirst.length === limit) break;
    }
    if (
      pageNewestFirst.length === limit ||
      pageRows.length < KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE
    ) {
      break;
    }
  }
  return finishBoundedKiloSdkMessageInfoEnumeration(
    db,
    pageNewestFirst,
    omittedItemCount,
    lastConsumedMessageStorageIdentity
  );
}

async function enumerateUnboundedKiloSdkMessageInfos(
  db: DrizzleSqliteDODatabase,
  r2: R2Bucket,
  budget: KiloSdkHistoryReadBudget
): Promise<KiloSdkMessageInfoEnumeration | KiloSdkHistoryReadFailure> {
  const messages: MaterializedKiloSdkMessage[] = [];
  let lastMessageRowId = 0;
  for (;;) {
    const messageRowIds = db
      .select({ id: ingestItems.id, item_id: ingestItems.item_id })
      .from(ingestItems)
      .where(and(eq(ingestItems.item_type, 'message'), gt(ingestItems.id, lastMessageRowId)))
      .orderBy(ingestItems.id)
      .limit(KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE)
      .all();
    if (messageRowIds.length === 0) break;
    for (const messageRowId of messageRowIds) {
      const storageIdentity = parsePersistedKiloSdkMessageStorageIdentity(messageRowId.item_id);
      if (!storageIdentity) {
        return { kind: 'invalid_data' };
      }
      const materialized = await readKiloSdkHistoryCandidate(
        messageRowId.id,
        rowId => readItemReference(db, rowId),
        r2,
        budget,
        'message_scan'
      );
      const outcome = resolveKiloSdkHistoryCandidateOutcome(materialized, 'fail', 'message_scan');
      if (outcome.kind !== 'skip' && outcome.kind !== 'value') {
        return outcome;
      }
      if (outcome.kind === 'value') {
        const identity = readMessageIdentity(outcome.value);
        if (!identity || identity.id !== storageIdentity.messageId) {
          return { kind: 'invalid_data' };
        }
        messages.push({ info: outcome.value, identity });
      }
      lastMessageRowId = messageRowId.id;
    }
    if (messageRowIds.length < KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE) break;
  }
  messages.sort(compareKiloSdkMessageInfo).reverse();
  return { pageNewestFirst: messages, nextCursor: null, omittedItemCount: 0 };
}

type KiloSdkMessagePartRowCount = { kind: 'count'; count: number } | KiloSdkInvalidData;

type PersistedKiloSdkPartStorageIdentity = {
  messageId: string;
  partId: string;
};

function parsePersistedKiloSdkPartStorageIdentity(
  itemId: string,
  expectedMessageId: string
): PersistedKiloSdkPartStorageIdentity | null {
  const segments = itemId.split('/');
  if (segments.length !== 2) return null;
  const [messageId, partId] = segments;
  const parsed = z.object({ messageId: messageIdSchema, partId: partIdSchema }).safeParse({
    messageId,
    partId,
  });
  return parsed.success && parsed.data.messageId === expectedMessageId ? parsed.data : null;
}

function countKiloSdkMessagePartRowsByMessageId(
  db: DrizzleSqliteDODatabase,
  messageId: string,
  afterRowId = 0
): KiloSdkMessagePartRowCount {
  if (!messageIdSchema.safeParse(messageId).success) return { kind: 'invalid_data' };
  const partRange = getPartItemIdentityRange(messageId);
  const broadCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'part'),
          gte(ingestItems.item_id, partRange.start),
          lt(ingestItems.item_id, partRange.end),
          gt(ingestItems.id, afterRowId)
        )
      )
      .get()?.count ?? 0;
  const directCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'part'),
          gte(ingestItems.item_id, partRange.start),
          lt(ingestItems.item_id, partRange.end),
          sql`substr(${ingestItems.item_id}, length(${partRange.start}) + 1, 3) = 'prt'`,
          sql`instr(substr(${ingestItems.item_id}, length(${partRange.start}) + 1), '/') = 0`,
          gt(ingestItems.id, afterRowId)
        )
      )
      .get()?.count ?? 0;
  const nulCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'part'),
          gte(ingestItems.item_id, partRange.start),
          lt(ingestItems.item_id, partRange.end),
          sql`instr(CAST(${ingestItems.item_id} AS BLOB), X'00') > 0`,
          gt(ingestItems.id, afterRowId)
        )
      )
      .get()?.count ?? 0;
  return broadCount === directCount && nulCount === 0
    ? { kind: 'count', count: directCount }
    : { kind: 'invalid_data' };
}

function countKiloSdkMessagePartRows(
  db: DrizzleSqliteDODatabase,
  identity: KiloSdkMessagesLegacyCursor,
  afterRowId = 0
): KiloSdkMessagePartRowCount {
  return countKiloSdkMessagePartRowsByMessageId(db, identity.id, afterRowId);
}

function countOmittedKiloSdkMessageRows(
  db: DrizzleSqliteDODatabase,
  messageItemId: string
): KiloSdkMessagePartRowCount {
  const storageIdentity = parsePersistedKiloSdkMessageStorageIdentity(messageItemId);
  if (!storageIdentity) return { kind: 'invalid_data' };
  const parts = countKiloSdkMessagePartRowsByMessageId(db, storageIdentity.messageId);
  return parts.kind === 'invalid_data' ? parts : { kind: 'count', count: 1 + parts.count };
}

async function hydrateKiloSdkMessageParts(
  db: DrizzleSqliteDODatabase,
  r2: R2Bucket,
  budget: KiloSdkHistoryReadBudget,
  identity: KiloSdkMessagesLegacyCursor,
  oversizedItemPolicy: KiloSdkOversizedItemPolicy
): Promise<
  | {
      parts: Array<Record<string, unknown>>;
      omittedItemCount: number;
      aggregateBudgetExhausted: boolean;
    }
  | KiloSdkHistoryReadFailure
> {
  const partRange = getPartItemIdentityRange(identity.id);
  const parts: Array<Record<string, unknown>> = [];
  let omittedItemCount = 0;
  let lastPartRowId = 0;
  for (;;) {
    const partRowIds = db
      .select({ id: ingestItems.id, item_id: ingestItems.item_id })
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'part'),
          gte(ingestItems.item_id, partRange.start),
          lt(ingestItems.item_id, partRange.end),
          gt(ingestItems.id, lastPartRowId)
        )
      )
      .orderBy(ingestItems.id)
      .limit(KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE)
      .all();
    if (partRowIds.length === 0) break;
    for (const partRowId of partRowIds) {
      const storageIdentity = parsePersistedKiloSdkPartStorageIdentity(
        partRowId.item_id,
        identity.id
      );
      if (!storageIdentity) {
        return { kind: 'invalid_data' };
      }
      const materialized = await readKiloSdkHistoryCandidate(
        partRowId.id,
        rowId => readItemReference(db, rowId),
        r2,
        budget,
        'page_parts'
      );
      if (materialized.kind === 'too_large') {
        if (oversizedItemPolicy === 'fail') return materialized;
        const remainingParts = countKiloSdkMessagePartRows(db, identity, partRowId.id);
        if (remainingParts.kind === 'invalid_data') {
          return remainingParts;
        }
        return {
          parts: parts.sort(compareKiloSdkPart),
          omittedItemCount: omittedItemCount + 1 + remainingParts.count,
          aggregateBudgetExhausted: true,
        };
      }
      const outcome = resolveKiloSdkHistoryCandidateOutcome(
        materialized,
        oversizedItemPolicy,
        'page_parts'
      );
      if (outcome.kind === 'skip') {
        omittedItemCount += 1;
      } else if (outcome.kind !== 'value') {
        return outcome;
      } else {
        const bodyIdentity = readPartIdentity(outcome.value);
        if (
          !bodyIdentity ||
          bodyIdentity.messageId !== identity.id ||
          bodyIdentity.messageId !== storageIdentity.messageId ||
          bodyIdentity.partId !== storageIdentity.partId
        ) {
          return { kind: 'invalid_data' };
        }
        parts.push(outcome.value);
      }
      lastPartRowId = partRowId.id;
    }
    if (partRowIds.length < KILO_SDK_HISTORY_ENUMERATION_BATCH_SIZE) break;
  }
  parts.sort(compareKiloSdkPart);
  return { parts, omittedItemCount, aggregateBudgetExhausted: false };
}

type BoundedItemRead =
  | { kind: 'value'; value: Record<string, unknown>; byteLength: number }
  | { kind: 'too_large'; byteLength: number }
  | { kind: 'invalid_data' }
  | { kind: 'r2_missing' };

function isSameItemReference(
  left: ItemDataRef | undefined,
  right: ItemDataRef | undefined
): boolean {
  return left?.item_data === right?.item_data && left?.item_data_r2_key === right?.item_data_r2_key;
}

async function readBoundedItemData(
  ref: ItemDataRef,
  r2: R2Bucket,
  maximumBytes: number
): Promise<BoundedItemRead> {
  if (!ref.item_data_r2_key) {
    const byteLength = new TextEncoder().encode(ref.item_data).byteLength;
    if (byteLength > maximumBytes) {
      return { kind: 'too_large', byteLength };
    }
    const value = parseItemObject(ref.item_data);
    return value ? { kind: 'value', value, byteLength } : { kind: 'invalid_data' };
  }

  const metadata = await r2.head(ref.item_data_r2_key);
  if (!metadata) {
    return { kind: 'r2_missing' };
  }
  if (metadata.size > maximumBytes) {
    return { kind: 'too_large', byteLength: metadata.size };
  }

  const object = await r2.get(ref.item_data_r2_key);
  if (!object || !('body' in object)) {
    return { kind: 'r2_missing' };
  }
  if (object.size > maximumBytes) {
    await object.body.cancel().catch(() => undefined);
    return { kind: 'too_large', byteLength: object.size };
  }

  const data = await object.text();
  const byteLength = new TextEncoder().encode(data).byteLength;
  if (byteLength > maximumBytes) {
    return { kind: 'too_large', byteLength };
  }
  const value = parseItemObject(data);
  return value ? { kind: 'value', value, byteLength } : { kind: 'invalid_data' };
}

export async function readKiloSdkSessionItem(
  ref: ItemDataRef,
  resolveCurrent: () => ItemDataRef | undefined,
  r2: R2Bucket,
  maximumBytes: number
): Promise<KiloSdkSessionSnapshotRead> {
  const result = await readBoundedItemData(ref, r2, maximumBytes);
  if (result.kind === 'value') {
    return { kind: 'value', info: result.value, byteLength: result.byteLength };
  }
  if (result.kind === 'too_large') {
    return { kind: 'too_large', maximumBytes };
  }
  if (result.kind === 'invalid_data') {
    return { kind: 'invalid_data' };
  }

  const current = resolveCurrent();
  if (!current || isSameItemReference(ref, current)) {
    return { kind: 'retryable_failure' };
  }
  const retry = await readBoundedItemData(current, r2, maximumBytes);
  if (retry.kind === 'value') {
    return { kind: 'value', info: retry.value, byteLength: retry.byteLength };
  }
  if (retry.kind === 'too_large') {
    return { kind: 'too_large', maximumBytes };
  }
  if (retry.kind === 'invalid_data') {
    return { kind: 'invalid_data' };
  }
  return { kind: 'retryable_failure' };
}

export async function readKiloSdkHistoryCandidate(
  rowId: number,
  resolveItem: (rowId: number) => ItemDataRef | undefined,
  r2: R2Bucket,
  budget: KiloSdkHistoryReadBudget,
  phase: KiloSdkHistoryReadPhase
): Promise<KiloSdkHistoryCandidateRead> {
  if (budget.consumedBytes + KILO_SDK_HISTORY_CANDIDATE_OVERHEAD_BYTES > budget.maximumBytes) {
    return { kind: 'too_large', maximumBytes: budget.maximumBytes, phase };
  }
  budget.consumedBytes += KILO_SDK_HISTORY_CANDIDATE_OVERHEAD_BYTES;
  const item = resolveItem(rowId);
  if (!item) {
    return { kind: 'missing' };
  }
  const materialized = await readKiloSdkHistoryItem(item, r2, budget, phase);
  if (materialized.kind !== 'retryable_failure') {
    return materialized;
  }

  const current = resolveItem(rowId);
  if (!current || isSameItemReference(item, current)) {
    return materialized;
  }
  return readKiloSdkHistoryItem(current, r2, budget, phase);
}

export async function readKiloSdkHistoryItem(
  ref: ItemDataRef,
  r2: R2Bucket,
  budget: KiloSdkHistoryReadBudget,
  phase: KiloSdkHistoryReadPhase
): Promise<
  | { kind: 'value'; value: Record<string, unknown> }
  | KiloSdkIntrinsicallyTooLarge
  | KiloSdkInvalidData
  | KiloSdkHistoryTooLarge
  | KiloSdkHistoryRetryableFailure
> {
  const materialized = await readBoundedItemData(
    ref,
    r2,
    budget.maximumBytes - budget.consumedBytes
  );
  if (materialized.kind === 'too_large') {
    return materialized.byteLength > budget.maximumBytes
      ? { kind: 'intrinsically_too_large' }
      : { kind: 'too_large', maximumBytes: budget.maximumBytes, phase };
  }
  if (materialized.kind === 'invalid_data') {
    return { kind: 'invalid_data' };
  }
  if (materialized.kind === 'r2_missing') {
    return { kind: 'retryable_failure', phase };
  }
  budget.consumedBytes += materialized.byteLength;
  return { kind: 'value', value: materialized.value };
}

function parseItemObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readMessageIdentity(message: Record<string, unknown>): KiloSdkMessagesLegacyCursor | null {
  const parsed = z
    .object({
      id: messageIdSchema,
      time: z.object({ created: z.number().nonnegative() }),
    })
    .transform(value => ({ id: value.id, time: value.time.created }))
    .safeParse(message);
  return parsed.success ? parsed.data : null;
}

function readPartIdentity(
  part: Record<string, unknown>
): PersistedKiloSdkPartStorageIdentity | null {
  const parsed = z
    .object({ id: partIdSchema, messageID: messageIdSchema })
    .transform(value => ({ partId: value.id, messageId: value.messageID }))
    .safeParse(part);
  return parsed.success ? parsed.data : null;
}

function compareKiloSdkMessageInfo(
  left: MaterializedKiloSdkMessage,
  right: MaterializedKiloSdkMessage
): number {
  return left.identity.time - right.identity.time || compareId(left.identity.id, right.identity.id);
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKiloSdkPart(left: Record<string, unknown>, right: Record<string, unknown>): number {
  if (typeof left.id !== 'string' || typeof right.id !== 'string') return 0;
  return compareId(left.id, right.id);
}
