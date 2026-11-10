import { withDORetry } from '@kilocode/worker-utils';
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
  type CloneVerificationProgress,
  type ExportCloneBatchResult,
  type FinalizeCloneStageResult,
  type IngestOrderCursor,
  type InspectCloneStageResult,
  type StageCloneBatchResult,
  type StageCloneVerificationResult,
} from '../dos/SessionIngestDO';
import { chainCloneRowDigest, cloneSourceDigestLine, utf8ByteLength } from '../util/clone-window';
import { parsePartItemIdentity } from '../util/compaction';
import { isItemWithinMessageCut } from '../util/message-cut';

const CLONE_BATCH_MAX_ROWS = 100;
/**
 * Largest materialized body one source row may contribute to a clone. The
 * source window the Durable Object exports is already byte-bounded, so this is
 * the per-row guard: a body above it cannot be staged at any batch size, and
 * the clone ends with a typed rejection before the body is read.
 */
const CLONE_MAX_ROW_MATERIALIZED_BYTES = 4 * 1024 * 1024;
/** Largest materialized payload one stage batch carries. */
const CLONE_MAX_BATCH_MATERIALIZED_BYTES = 4 * 1024 * 1024;
const CLONE_MAX_BATCHES_PER_REQUEST = 16;
/**
 * One clone request reads at most this many source rows, counting every row of
 * the copy windows and of the source verification the same request advances.
 * Progress is recorded in the destination stage, so a source longer than the
 * budget finishes over several requests instead of restarting.
 */
const CLONE_REQUEST_MAX_SOURCE_ROWS = CLONE_BATCH_MAX_ROWS * CLONE_MAX_BATCHES_PER_REQUEST;

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

/** The row as the stage stores it. An R2-backed row stores `{}` and its key. */
type RewrittenCloneRow = {
  itemId: string;
  itemType: CloneItemType;
  itemData: string;
  itemDataR2Key: string | null;
  ingestedAt: number | null;
  materializedByteLength: number;
};

/**
 * One materialized row plus the body to write to R2 before staging. The body
 * stays out of {@link RewrittenCloneRow} so a staged row never retains it, and
 * the union keeps the body and the destination key from drifting apart.
 */
type MaterializedCloneRow =
  | {
      row: RewrittenCloneRow & { itemDataR2Key: null };
      destinationR2Body: null;
    }
  | {
      row: RewrittenCloneRow & { itemDataR2Key: string };
      destinationR2Body: string;
    };

type SessionIngestDOStub = ReturnType<typeof getSessionIngestDO>;

/** Source rows one clone request has read, shared by the copy and verification loops. */
type SourceReadBudget = { rowsRead: number };

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

/**
 * Keep only clone-eligible item types inside the optional message cut. The
 * source DO already filters its export to `CLONE_ITEM_TYPES`; this guard keeps
 * the helper consistent if a caller ever hands it rows outside that set. Both
 * the copy and the source verification use this predicate, so the staged count
 * and the verified count agree.
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
  const identity = parsePartItemIdentity(itemId);
  if (identity === null) return null;
  if (!messageIdSchema.safeParse(identity.messageId).success) return null;
  if (!partIdSchema.safeParse(identity.partId).success) return null;
  return identity;
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

/**
 * Read one row's body only after its stored size is known to fit the row
 * budget. An R2 object reports its size before its body is read, and an inline
 * body is already in memory under the ingest item cap, so neither path buffers
 * a body the clone would reject.
 */
async function materializeAndRewriteRow(
  row: CloneBatchRow,
  r2: R2Bucket,
  sourceSessionId: string,
  destinationSessionId: string
): Promise<MaterializedCloneRow> {
  let rawText: string;
  if (row.itemDataR2Key !== null) {
    const object = await r2.get(row.itemDataR2Key);
    if (object === null) throw new CloneRejectionError('missing_source_body');
    if (object.size > CLONE_MAX_ROW_MATERIALIZED_BYTES) {
      throw new CloneRejectionError('clone_setup_failed');
    }
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
  const materializedByteLength = utf8ByteLength(rewrittenJson);
  if (materializedByteLength > CLONE_MAX_ROW_MATERIALIZED_BYTES) {
    throw new CloneRejectionError('clone_setup_failed');
  }

  if (row.itemDataR2Key !== null) {
    return {
      row: {
        itemId: row.itemId,
        itemType: row.itemType,
        itemData: '{}',
        itemDataR2Key: `clone/${destinationSessionId}/${row.itemId}`,
        ingestedAt: row.ingestedAt,
        materializedByteLength,
      },
      destinationR2Body: rewrittenJson,
    };
  }

  return {
    row: {
      itemId: row.itemId,
      itemType: row.itemType,
      itemData: rewrittenJson,
      itemDataR2Key: null,
      ingestedAt: row.ingestedAt,
      materializedByteLength,
    },
    destinationR2Body: null,
  };
}

/**
 * Materialize, rewrite, and stage the clone-eligible rows of one source window
 * until the batch reaches the materialized-byte budget, then stop before the
 * row that would not fit. An R2 destination body is written the moment its row
 * is accepted, so the request never keeps more than one body in memory. The
 * caller re-exports the consumed prefix to recover the resume cursor.
 */
async function materializeSourceBatch(
  rows: CloneBatchRow[],
  upToMessageId: string | undefined,
  r2: R2Bucket,
  sourceSessionId: string,
  destinationSessionId: string,
  writtenR2Keys: string[],
  chain: string
): Promise<{ rows: RewrittenCloneRow[]; chain: string; consumedSourceRows: number }> {
  const rewritten: RewrittenCloneRow[] = [];
  let batchChain = chain;
  let bytes = 0;
  let consumed = 0;
  for (const [index, row] of rows.entries()) {
    if (!isCloneEligibleRow(row, upToMessageId)) {
      consumed = index + 1;
      batchChain = await chainCloneRowDigest(batchChain, cloneSourceDigestLine(row));
      continue;
    }
    const materialized = await materializeAndRewriteRow(
      row,
      r2,
      sourceSessionId,
      destinationSessionId
    );
    const staged = materialized.row;
    if (
      rewritten.length > 0 &&
      bytes + staged.materializedByteLength > CLONE_MAX_BATCH_MATERIALIZED_BYTES
    ) {
      break;
    }
    if (materialized.destinationR2Body !== null) {
      // Write the body now and keep only the key, so the batch holds one body at
      // a time.
      await r2.put(materialized.row.itemDataR2Key, materialized.destinationR2Body);
      writtenR2Keys.push(materialized.row.itemDataR2Key);
    }
    bytes += staged.materializedByteLength;
    consumed = index + 1;
    batchChain = await chainCloneRowDigest(batchChain, cloneSourceDigestLine(row));
    rewritten.push(staged);
  }
  return { rows: rewritten, chain: batchChain, consumedSourceRows: consumed };
}

async function exportSourceWindow(
  sourceStub: () => SessionIngestDOStub,
  cursor: IngestOrderCursor | null
): Promise<ExportCloneBatchResult> {
  return withDORetry<SessionIngestDOStub, ExportCloneBatchResult>(
    sourceStub,
    stub => stub.exportCloneBatch(cursor, CLONE_BATCH_MAX_ROWS),
    'SessionIngestDO.exportCloneBatch'
  );
}

type VerifyOutcome = 'verified' | 'in_progress' | 'changed' | 'setup_failed';

/**
 * Re-read the source window by window and compare the per-row digest chain and
 * the clone-eligible row count against what the stage recorded. Row chaining is
 * independent of the window split, so this pass reads the same rows in
 * whatever windows the source hands out. The request-wide row budget and the
 * per-request window cap bound the work one request does; progress is persisted
 * in the stage before signalling `in_progress`, so a source longer than the
 * budget is verified over several requests.
 */
async function verifyCloneSource(params: {
  sourceStub: () => SessionIngestDOStub;
  upToMessageId: string | undefined;
  targetChain: string;
  targetItemCount: number;
  progress: CloneVerificationProgress;
  budget: SourceReadBudget;
  persist: (progress: CloneVerificationProgress) => Promise<StageCloneVerificationResult>;
}): Promise<VerifyOutcome> {
  let cursor = params.progress.verifyCursor;
  let chain = params.progress.verifyChain;
  let rows = params.progress.verifyRows;
  let windowsRead = 0;

  for (;;) {
    if (
      params.budget.rowsRead >= CLONE_REQUEST_MAX_SOURCE_ROWS ||
      windowsRead >= CLONE_MAX_BATCHES_PER_REQUEST
    ) {
      const persisted = await params.persist({
        verifyCursor: cursor,
        verifyChain: chain,
        verifyRows: rows,
      });
      return persisted.status === 'staged' ? 'in_progress' : 'setup_failed';
    }

    const exported = await exportSourceWindow(params.sourceStub, cursor);
    params.budget.rowsRead += exported.rows.length;
    windowsRead += 1;
    for (const row of exported.rows) {
      chain = await chainCloneRowDigest(chain, cloneSourceDigestLine(row));
      if (isCloneEligibleRow(row, params.upToMessageId)) rows += 1;
    }
    if (rows > params.targetItemCount) return 'changed';
    cursor = exported.nextCursor;
    if (exported.done) break;
  }

  if (rows !== params.targetItemCount || chain !== params.targetChain) return 'changed';
  return 'verified';
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
 * PostgreSQL insert. Returns `in_progress` when the request row budget is
 * exhausted before the copy and its verification finish, keeping the stage for a
 * same-key retry. Returns a typed `rejected` result and resets the destination
 * stage for any terminal failure, leaving no PostgreSQL row behind.
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

  const reject = async (code: SessionCloneRejectionCode): Promise<CloneSessionOutcome> => {
    await resetDestinationStage(destinationStub);
    await deleteDestinationR2Bodies(r2, writtenDestinationR2Keys);
    return { status: 'rejected', code };
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
    // A finalized stage recorded the item count and digest it verified against
    // the source. Trust that record instead of scanning the source again.
    return { status: 'ready', copiedItemCount: inspected.copiedItemCount };
  }

  let cursor: IngestOrderCursor | null = null;
  let chain = '';
  let copiedItemCount = 0;
  let verification: CloneVerificationProgress = {
    verifyCursor: null,
    verifyChain: '',
    verifyRows: 0,
  };
  let needsCloneLoop = true;

  if (inspected.status === 'in_progress') {
    cursor = inspected.nextCursor;
    chain = inspected.rollingDigest;
    copiedItemCount = inspected.copiedItemCount;
    verification = {
      verifyCursor: inspected.verifyCursor,
      verifyChain: inspected.verifyChain,
      verifyRows: inspected.verifyRows,
    };
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

  const budget: SourceReadBudget = { rowsRead: 0 };

  if (needsCloneLoop) {
    let batchesProcessed = 0;
    for (;;) {
      if (budget.rowsRead >= CLONE_REQUEST_MAX_SOURCE_ROWS) {
        return { status: 'in_progress' };
      }

      const exported = await exportSourceWindow(sourceStub, cursor);
      budget.rowsRead += exported.rows.length;

      let batch: {
        rows: RewrittenCloneRow[];
        chain: string;
        consumedSourceRows: number;
      };
      try {
        batch = await materializeSourceBatch(
          exported.rows,
          upToMessageId,
          r2,
          sourceSessionId,
          destinationSessionId,
          writtenDestinationR2Keys,
          chain
        );
      } catch (error) {
        if (error instanceof CloneRejectionError) return reject(error.code);
        throw error;
      }

      let nextCursor = exported.nextCursor;
      let done = exported.done;
      if (batch.consumedSourceRows < exported.rows.length) {
        // The batch stopped before the row that exceeded the materialized-byte
        // budget. The row id is not part of a source row, so re-export the
        // consumed prefix (bounded by one window) for the resume cursor.
        budget.rowsRead += batch.consumedSourceRows;
        const prefix = await withDORetry<SessionIngestDOStub, ExportCloneBatchResult>(
          sourceStub,
          stub => stub.exportCloneBatch(cursor, batch.consumedSourceRows),
          'SessionIngestDO.exportCloneBatch'
        );
        nextCursor = prefix.nextCursor;
        done = false;
      }

      copiedItemCount += batch.rows.length;
      chain = batch.chain;

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
            nextCursor,
            rollingDigest: chain,
            copiedItemCount,
          }),
        'SessionIngestDO.stageCloneBatch'
      );

      if (staged.status === 'mismatch') {
        return reject('clone_setup_failed');
      }

      cursor = nextCursor;
      batchesProcessed += 1;

      if (done) break;
      if (batchesProcessed >= CLONE_MAX_BATCHES_PER_REQUEST) {
        return { status: 'in_progress' };
      }
    }
  }

  // Verification: compare the source against the staged digest and count. The
  // request row budget bounds this pass, and the stage records its progress, so
  // a source longer than the budget verifies across several requests.
  const verified = await verifyCloneSource({
    sourceStub,
    upToMessageId,
    targetChain: chain,
    targetItemCount: copiedItemCount,
    progress: verification,
    budget,
    persist: progress =>
      withDORetry<SessionIngestDOStub, StageCloneVerificationResult>(
        destinationStub,
        stub => stub.stageCloneVerification({ ...stageIdentity, ...progress }),
        'SessionIngestDO.stageCloneVerification'
      ),
  });
  if (verified === 'changed') return reject('source_digest_changed');
  if (verified === 'setup_failed') return reject('clone_setup_failed');
  if (verified === 'in_progress') return { status: 'in_progress' };

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
          rollingDigest: chain,
          copiedItemCount: 0,
        }),
      'SessionIngestDO.stageCloneBatch'
    );
    if (stagedEmpty.status === 'mismatch') {
      return reject('clone_setup_failed');
    }
  }

  const finalized = await withDORetry<SessionIngestDOStub, FinalizeCloneStageResult>(
    destinationStub,
    stub =>
      stub.finalizeCloneStage({
        ...stageIdentity,
        finalDigest: chain,
        finalItemCount: copiedItemCount,
      }),
    'SessionIngestDO.finalizeCloneStage'
  );

  if (finalized.status === 'mismatch' || finalized.status === 'empty') {
    return reject('clone_setup_failed');
  }
  if (finalized.status === 'digest_mismatch') {
    return reject('source_digest_changed');
  }

  return { status: 'ready', copiedItemCount };
}
