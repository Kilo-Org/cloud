import { sha256Hex, withDORetry } from '@kilocode/worker-utils';
import {
  kiloSdkSessionInfoSchema,
  messageIdSchema,
  partIdSchema,
  type SessionCloneRejectionCode,
} from '@kilocode/session-ingest-contracts';

import type { Env } from '../env';
import {
  getSessionIngestDO,
  CLONE_ITEM_TYPES,
  type CloneBatchRow,
  type CloneItemType,
  type CloneStageIdentity,
  type ExportCloneBatchResult,
  type FinalizeCloneStageResult,
  type IngestOrderCursor,
  type InspectCloneStageResult,
  type StageCloneBatchResult,
} from '../dos/SessionIngestDO';
import { isItemWithinMessageCut } from '../util/message-cut';

const CLONE_BATCH_MAX_ROWS = 100;
const CLONE_BATCH_MAX_MATERIALIZED_BYTES = 4 * 1024 * 1024;
const CLONE_MAX_BATCHES_PER_REQUEST = 16;

export type CloneSessionOutcome =
  | { status: 'ready'; copiedItemCount: number }
  | { status: 'in_progress' }
  | { status: 'rejected'; code: SessionCloneRejectionCode };

export type CloneSessionParams = {
  env: Env;
  kiloUserId: string;
  sourceSessionId: string;
  destinationSessionId: string;
  sourceOrganizationId: string | null;
  destinationOrganizationId: string | null;
  destinationTitle?: string;
  /** Inclusive message cut; absent clones the full transcript. */
  upToMessageId?: string;
};

type RewrittenCloneRow = {
  itemId: string;
  itemType: CloneItemType;
  itemData: string;
  ingestedAt: number | null;
  sourceDigestLine: string;
  materializedByteLength: number;
} & (
  | { itemDataR2Key: null; destinationR2Body: null }
  | { itemDataR2Key: string; destinationR2Body: string }
);

type SessionIngestDOStub = ReturnType<typeof getSessionIngestDO>;

class CloneRejectionError extends Error {
  readonly code: SessionCloneRejectionCode;

  constructor(code: SessionCloneRejectionCode) {
    super(`Session clone rejected: ${code}`);
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceDigestLine(row: CloneBatchRow): string {
  return `${row.itemId}:${row.itemType}:${row.itemDataR2Key ?? row.itemData}`;
}

/**
 * Keep only clone-eligible item types inside the optional message cut. The
 * source DO already filters its export to `CLONE_ITEM_TYPES`; this guard keeps
 * the helper consistent if a caller ever hands it rows outside that set. Every
 * pass (copy, resume digest, final verification digest) uses this predicate,
 * so the staged count and digests all agree.
 */
function isCloneEligibleRow(row: CloneBatchRow, upToMessageId: string | undefined): boolean {
  return (
    CLONE_ITEM_TYPES.includes(row.itemType) &&
    (upToMessageId === undefined || isItemWithinMessageCut(row, upToMessageId))
  );
}

function parseItemJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseMessageItemId(itemId: string): string | null {
  const prefix = 'message/';
  if (!itemId.startsWith(prefix)) return null;
  const id = itemId.slice(prefix.length);
  return messageIdSchema.safeParse(id).success ? id : null;
}

function parsePartItemId(itemId: string): { messageId: string; partId: string } | null {
  const segments = itemId.split('/');
  if (segments.length !== 2) return null;
  const [messageId, partId] = segments;
  if (!messageIdSchema.safeParse(messageId).success || !partIdSchema.safeParse(partId).success) {
    return null;
  }
  return { messageId, partId };
}

const SESSION_INFO_ALLOWLIST = [
  'slug',
  'projectID',
  'workspaceID',
  'summary',
  'title',
  'agent',
  'model',
  'version',
  'time',
  'permission',
] as const;

function buildDestinationSessionInfo(
  source: Record<string, unknown>,
  destinationSessionId: string
): Record<string, unknown> {
  const info: Record<string, unknown> = { id: destinationSessionId, directory: '' };
  for (const key of SESSION_INFO_ALLOWLIST) {
    if (key in source) info[key] = source[key];
  }
  return info;
}

function synthesizeEmptySessionInfo(
  destinationSessionId: string,
  title: string | undefined
): Record<string, unknown> {
  const now = Date.now();
  return {
    id: destinationSessionId,
    slug: destinationSessionId,
    projectID: 'cloud-agent',
    directory: '',
    title: title ?? '',
    version: 'cloud-agent',
    time: { created: now, updated: now },
  };
}

async function materializeAndRewriteRow(
  row: CloneBatchRow,
  r2: R2Bucket,
  sourceSessionId: string,
  destinationSessionId: string
): Promise<RewrittenCloneRow> {
  const digestLine = sourceDigestLine(row);

  let rawText: string;
  if (row.itemDataR2Key !== null) {
    const object = await r2.get(row.itemDataR2Key);
    if (object === null) throw new CloneRejectionError('missing_source_body');
    rawText = await object.text();
  } else {
    rawText = row.itemData;
  }

  const parsed = parseItemJson(rawText);
  if (parsed === null) throw new CloneRejectionError('malformed_source_data');

  let rewritten: unknown;
  if (row.itemType === 'session') {
    if (!isRecord(parsed) || parsed['id'] !== sourceSessionId) {
      throw new CloneRejectionError('malformed_source_data');
    }
    const info = buildDestinationSessionInfo(parsed, destinationSessionId);
    if (!kiloSdkSessionInfoSchema.safeParse(info).success) {
      throw new CloneRejectionError('malformed_source_data');
    }
    rewritten = info;
  } else if (row.itemType === 'message') {
    const messageId = parseMessageItemId(row.itemId);
    if (
      messageId === null ||
      !isRecord(parsed) ||
      parsed['id'] !== messageId ||
      parsed['sessionID'] !== sourceSessionId
    ) {
      throw new CloneRejectionError('malformed_source_data');
    }
    rewritten = { ...parsed, sessionID: destinationSessionId };
  } else if (row.itemType === 'part') {
    const identity = parsePartItemId(row.itemId);
    if (
      identity === null ||
      !isRecord(parsed) ||
      parsed['id'] !== identity.partId ||
      parsed['messageID'] !== identity.messageId ||
      parsed['sessionID'] !== sourceSessionId
    ) {
      throw new CloneRejectionError('malformed_source_data');
    }
    rewritten = { ...parsed, sessionID: destinationSessionId };
  } else {
    // session_diff: an array of diffs with no identity to rewrite.
    rewritten = parsed;
  }

  const rewrittenJson = JSON.stringify(rewritten);
  const materializedByteLength = new TextEncoder().encode(rewrittenJson).byteLength;

  if (row.itemDataR2Key !== null) {
    const destinationKey = `clone/${destinationSessionId}/${row.itemId}`;
    return {
      itemId: row.itemId,
      itemType: row.itemType,
      itemData: '{}',
      itemDataR2Key: destinationKey,
      ingestedAt: row.ingestedAt,
      sourceDigestLine: digestLine,
      materializedByteLength,
      destinationR2Body: rewrittenJson,
    };
  }

  return {
    itemId: row.itemId,
    itemType: row.itemType,
    itemData: rewrittenJson,
    itemDataR2Key: null,
    ingestedAt: row.ingestedAt,
    sourceDigestLine: digestLine,
    materializedByteLength,
    destinationR2Body: null,
  };
}

async function materializeBatchWithinBudget(
  exported: { rows: CloneBatchRow[]; nextCursor: IngestOrderCursor | null; done: boolean },
  cursor: IngestOrderCursor | null,
  sourceStub: () => SessionIngestDOStub,
  r2: R2Bucket,
  sourceSessionId: string,
  destinationSessionId: string,
  upToMessageId: string | undefined,
  writtenR2Keys: string[]
): Promise<{ rows: RewrittenCloneRow[]; nextCursor: IngestOrderCursor | null; done: boolean }> {
  const rows: RewrittenCloneRow[] = [];
  let bytes = 0;
  // Source rows consumed by this batch, counting rows the cut skips, so the
  // resume cursor lands just before the first row that did not fit.
  let consumedSourceRows = exported.rows.length;
  for (const [index, row] of exported.rows.entries()) {
    if (!isCloneEligibleRow(row, upToMessageId)) continue;
    const rewritten = await materializeAndRewriteRow(
      row,
      r2,
      sourceSessionId,
      destinationSessionId
    );
    if (
      rows.length > 0 &&
      bytes + rewritten.materializedByteLength > CLONE_BATCH_MAX_MATERIALIZED_BYTES
    ) {
      consumedSourceRows = index;
      break;
    }
    if (rewritten.itemDataR2Key !== null) {
      await r2.put(rewritten.itemDataR2Key, rewritten.destinationR2Body);
      writtenR2Keys.push(rewritten.itemDataR2Key);
    }
    rows.push(rewritten);
    bytes += rewritten.materializedByteLength;
  }

  if (consumedSourceRows === exported.rows.length) {
    return { rows, nextCursor: exported.nextCursor, done: exported.done };
  }

  // The batch exceeded the byte budget: re-export the exact prefix to recover
  // the correct resume cursor (the row id is not part of CloneBatchRow).
  const prefix = await withDORetry<SessionIngestDOStub, ExportCloneBatchResult>(
    sourceStub,
    stub => stub.exportCloneBatch(cursor, consumedSourceRows),
    'SessionIngestDO.exportCloneBatch'
  );
  return { rows, nextCursor: prefix.nextCursor, done: false };
}

async function exportAllSourceRows(
  sourceStub: () => SessionIngestDOStub,
  upToMessageId: string | undefined
): Promise<{ digestLines: string[]; itemCount: number }> {
  const digestLines: string[] = [];
  let cursor: IngestOrderCursor | null = null;
  for (;;) {
    const exported = await withDORetry<SessionIngestDOStub, ExportCloneBatchResult>(
      sourceStub,
      stub => stub.exportCloneBatch(cursor, CLONE_BATCH_MAX_ROWS),
      'SessionIngestDO.exportCloneBatch'
    );
    if (exported.rows.length === 0) break;
    for (const row of exported.rows) {
      if (isCloneEligibleRow(row, upToMessageId)) digestLines.push(sourceDigestLine(row));
    }
    cursor = exported.nextCursor;
    if (exported.done) break;
  }
  return { digestLines, itemCount: digestLines.length };
}

async function rebuildPrefixDigestLines(
  sourceStub: () => SessionIngestDOStub,
  copiedItemCount: number,
  upToMessageId: string | undefined
): Promise<string[]> {
  const digestLines: string[] = [];
  let cursor: IngestOrderCursor | null = null;
  while (digestLines.length < copiedItemCount) {
    const exported = await withDORetry<SessionIngestDOStub, ExportCloneBatchResult>(
      sourceStub,
      stub => stub.exportCloneBatch(cursor, CLONE_BATCH_MAX_ROWS),
      'SessionIngestDO.exportCloneBatch'
    );
    if (exported.rows.length === 0) break;
    for (const row of exported.rows) {
      if (!isCloneEligibleRow(row, upToMessageId)) continue;
      if (digestLines.length >= copiedItemCount) break;
      digestLines.push(sourceDigestLine(row));
    }
    cursor = exported.nextCursor;
    if (exported.done) break;
  }
  return digestLines;
}

async function resetDestinationStage(destinationStub: () => SessionIngestDOStub): Promise<void> {
  await withDORetry<SessionIngestDOStub, void>(
    destinationStub,
    stub => stub.resetCloneStage(),
    'SessionIngestDO.resetCloneStage'
  );
}

/**
 * Delete destination-owned R2 bodies that were written but never staged. Called
 * on reject so a failed clone leaves no orphaned bodies behind. Best-effort:
 * a delete failure is logged and must not turn a typed rejection into a throw.
 */
async function deleteDestinationR2Bodies(r2: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await r2.delete(keys);
  } catch (error) {
    console.error('Failed to delete destination clone R2 bodies', {
      count: keys.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Copy the source session's clone-eligible ingest rows into the destination
 * session's Durable Object stage, bounded and resumable across requests.
 *
 * Returns `ready` only after the stage is finalized; the caller then runs the
 * PostgreSQL insert. Returns `in_progress` when the request budget is exhausted
 * before the copy finishes, keeping the stage for a same-key retry. Returns a
 * typed `rejected` result and resets the destination stage for any terminal
 * failure, leaving no PostgreSQL row behind.
 */
export async function cloneSessionIntoDestination(
  params: CloneSessionParams
): Promise<CloneSessionOutcome> {
  const {
    env,
    kiloUserId,
    sourceSessionId,
    destinationSessionId,
    sourceOrganizationId,
    destinationOrganizationId,
    destinationTitle,
    upToMessageId,
  } = params;

  if (sourceOrganizationId !== destinationOrganizationId) {
    return { status: 'rejected', code: 'organization_mismatch' };
  }

  const sourceStub = () => getSessionIngestDO(env, { kiloUserId, sessionId: sourceSessionId });
  const destinationStub = () =>
    getSessionIngestDO(env, { kiloUserId, sessionId: destinationSessionId });
  const r2 = env.SESSION_INGEST_R2;
  // Destination R2 keys written by this request that were never staged. Deleted
  // on reject so a failed clone leaves no orphaned destination bodies.
  const writtenDestinationR2Keys: string[] = [];
  // The stage identity includes the cut, so a stage built for another cut is a
  // mismatch exactly like a stage built for another source.
  const stageIdentity: CloneStageIdentity = {
    sourceSessionId,
    destinationSessionId,
    ...(upToMessageId !== undefined ? { upToMessageId } : {}),
  };

  if (upToMessageId !== undefined) {
    const hasCutMessage = await withDORetry<SessionIngestDOStub, boolean>(
      sourceStub,
      stub => stub.hasMessageItem(upToMessageId),
      'SessionIngestDO.hasMessageItem'
    );
    if (!hasCutMessage) {
      return { status: 'rejected', code: 'clone_cut_not_found' };
    }
  }

  const inspected = await withDORetry<SessionIngestDOStub, InspectCloneStageResult>(
    destinationStub,
    stub => stub.inspectCloneStage(stageIdentity),
    'SessionIngestDO.inspectCloneStage'
  );

  if (inspected.status === 'complete') {
    const { itemCount } = await exportAllSourceRows(sourceStub, upToMessageId);
    return { status: 'ready', copiedItemCount: itemCount };
  }

  let cursor: IngestOrderCursor | null = null;
  let digestLines: string[] = [];
  let copiedItemCount = 0;
  let needsCloneLoop = true;

  if (inspected.status === 'in_progress') {
    cursor = inspected.nextCursor;
    copiedItemCount = inspected.copiedItemCount;
    digestLines = await rebuildPrefixDigestLines(sourceStub, copiedItemCount, upToMessageId);
    const rebuiltDigest = await sha256Hex(digestLines.join('\n'));
    if (rebuiltDigest !== inspected.rollingDigest) {
      await resetDestinationStage(destinationStub);
      return { status: 'rejected', code: 'source_digest_changed' };
    }
    needsCloneLoop = cursor !== null;
  } else if (inspected.status === 'mismatch') {
    // A complete destination that belongs to another source or cut is already
    // published: reject terminally and never reset it. An incomplete stage from
    // another source or cut is unpublished and may be reset before restarting.
    if (inspected.storedStage === 'complete') {
      return { status: 'rejected', code: 'destination_conflict' };
    }
    await resetDestinationStage(destinationStub);
  }

  if (needsCloneLoop) {
    let batchesProcessed = 0;
    for (;;) {
      const exported = await withDORetry<SessionIngestDOStub, ExportCloneBatchResult>(
        sourceStub,
        stub => stub.exportCloneBatch(cursor, CLONE_BATCH_MAX_ROWS),
        'SessionIngestDO.exportCloneBatch'
      );
      if (exported.rows.length === 0) break;

      let batch: { rows: RewrittenCloneRow[]; nextCursor: IngestOrderCursor | null; done: boolean };
      try {
        batch = await materializeBatchWithinBudget(
          exported,
          cursor,
          sourceStub,
          r2,
          sourceSessionId,
          destinationSessionId,
          upToMessageId,
          writtenDestinationR2Keys
        );
      } catch (error) {
        if (error instanceof CloneRejectionError) {
          await resetDestinationStage(destinationStub);
          await deleteDestinationR2Bodies(r2, writtenDestinationR2Keys);
          return { status: 'rejected', code: error.code };
        }
        throw error;
      }

      for (const row of batch.rows) {
        digestLines.push(row.sourceDigestLine);
        copiedItemCount += 1;
      }
      const rollingDigest = await sha256Hex(digestLines.join('\n'));

      const staged = await withDORetry<SessionIngestDOStub, StageCloneBatchResult>(
        destinationStub,
        stub =>
          stub.stageCloneBatch({
            ...stageIdentity,
            rows: batch.rows.map(row => ({
              itemId: row.itemId,
              itemType: row.itemType,
              itemData: row.itemData,
              itemDataR2Key: row.itemDataR2Key,
              ingestedAt: row.ingestedAt,
            })),
            nextCursor: batch.nextCursor,
            rollingDigest,
            copiedItemCount,
          }),
        'SessionIngestDO.stageCloneBatch'
      );

      if (staged.status === 'mismatch') {
        await resetDestinationStage(destinationStub);
        await deleteDestinationR2Bodies(r2, writtenDestinationR2Keys);
        return { status: 'rejected', code: 'clone_setup_failed' };
      }

      cursor = batch.nextCursor;
      batchesProcessed += 1;

      if (batch.done) break;
      if (batchesProcessed >= CLONE_MAX_BATCHES_PER_REQUEST) {
        return { status: 'in_progress' };
      }
    }
  }

  // Final verification: re-export the source from scratch and compare the
  // source digest and item count against the staged rolling digest and count.
  const final = await exportAllSourceRows(sourceStub, upToMessageId);
  const finalDigest = await sha256Hex(final.digestLines.join('\n'));
  const rollingDigest = await sha256Hex(digestLines.join('\n'));

  if (finalDigest !== rollingDigest || final.itemCount !== copiedItemCount) {
    await resetDestinationStage(destinationStub);
    return { status: 'rejected', code: 'source_digest_changed' };
  }

  if (copiedItemCount === 0) {
    const sessionInfo = synthesizeEmptySessionInfo(destinationSessionId, destinationTitle);
    const stagedEmpty = await withDORetry<SessionIngestDOStub, StageCloneBatchResult>(
      destinationStub,
      stub =>
        stub.stageCloneBatch({
          ...stageIdentity,
          rows: [
            {
              itemId: 'session',
              itemType: 'session',
              itemData: JSON.stringify(sessionInfo),
              itemDataR2Key: null,
              ingestedAt: null,
            },
          ],
          nextCursor: null,
          rollingDigest,
          copiedItemCount: 0,
        }),
      'SessionIngestDO.stageCloneBatch'
    );
    if (stagedEmpty.status === 'mismatch') {
      await resetDestinationStage(destinationStub);
      return { status: 'rejected', code: 'clone_setup_failed' };
    }
  }

  const finalized = await withDORetry<SessionIngestDOStub, FinalizeCloneStageResult>(
    destinationStub,
    stub =>
      stub.finalizeCloneStage({
        ...stageIdentity,
        finalDigest,
        finalItemCount: copiedItemCount,
      }),
    'SessionIngestDO.finalizeCloneStage'
  );

  if (finalized.status === 'mismatch' || finalized.status === 'empty') {
    await resetDestinationStage(destinationStub);
    return { status: 'rejected', code: 'clone_setup_failed' };
  }
  if (finalized.status === 'digest_mismatch') {
    await resetDestinationStage(destinationStub);
    return { status: 'rejected', code: 'source_digest_changed' };
  }

  return { status: 'ready', copiedItemCount };
}
