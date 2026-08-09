import { ExportQueueMessageSchema, type ExportQueueMessage, parseCursor } from './contracts';
import {
  createReplicaQuery,
  createStateDb,
  type ExportJob,
  type HyperdriveBinding,
} from './databases';
import { uploadGzipStream } from './gzip';
import { createSourceAdapters, type ExportRecord } from './source-adapters';

const PART_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES_PER_INVOCATION = 32 * 1024 * 1024;
const MAX_PAGES_PER_INVOCATION = 200;
const PAGE_SIZE = 100;

export type ExportEnv = {
  PRIMARY_STATE_DB: HyperdriveBinding;
  EXPORT_REPLICA_DB: HyperdriveBinding;
  EXPORT_BUCKET: R2Bucket;
  EXPORT_QUEUE: Queue<ExportQueueMessage>;
  INTERNAL_API_SECRET: string | { get(): Promise<string> };
  R2_ACCESS_KEY_ID: string | { get(): Promise<string> };
  R2_SECRET_ACCESS_KEY: string | { get(): Promise<string> };
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  USER_DATA_EXPORT_WEB_URL?: string;
};

function objectKey(exportId: string): string {
  return `exports/${exportId}/kilo-data-export.jsonl.gz`;
}

export const exportArtifact = {
  contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
  contentType: 'application/gzip',
  partBytes: PART_BYTES,
} as const;

export function isAllowedWebCallbackUrl(value: string): boolean {
  const url = new URL(value);
  return (
    (url.protocol === 'https:' &&
      (url.hostname === 'app.kilo.ai' || url.hostname === 'staging-app.kilo.ai')) ||
    (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
  );
}

function jsonLine(record: ExportRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function exportHeader(job: ExportJob): string {
  return `${JSON.stringify({
    type: 'header',
    schemaVersion: 1,
    exportId: job.id,
    requestedAt: job.snapshot_at,
    generatedAt: new Date().toISOString(),
    includedSources: ['app_builder_projects', 'microdollar_usage_metadata', 'system_prompt_prefix'],
    unavailableSources: [
      { source: 'app_builder_messages', reason: 'source_table_dropped' },
      { source: 'numbered_cli_journal', reason: 'source_not_found' },
    ],
    consistencyMode: 'membership_cutoff_with_fuzzy_mutable_values',
    snapshotAt: job.snapshot_at,
  })}\n`;
}

export async function processGenerateMessage(
  env: ExportEnv,
  message: ExportQueueMessage
): Promise<void> {
  const state = createStateDb(env.PRIMARY_STATE_DB);
  const leaseToken = crypto.randomUUID();
  const job = await state.claim(message.exportId, message.generation, leaseToken);
  if (!job) return;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let uploadParts:
    | Promise<Array<{ partNumber: number; etag: string; sizeBytes: number }>>
    | undefined;

  try {
    if (job.current_source === null && job.multipart_upload_id) {
      await finalizeExport(env, state, job, leaseToken);
      return;
    }

    const adapters = createSourceAdapters(createReplicaQuery(env.EXPORT_REPLICA_DB));
    let adapter = adapters.find(candidate => candidate.name === job.current_source) ?? adapters[0];
    if (!adapter || !adapter.readPage) {
      throw new Error('Export job has an invalid current source');
    }

    const key = objectKey(job.id);
    const upload = job.multipart_upload_id
      ? env.EXPORT_BUCKET.resumeMultipartUpload(key, job.multipart_upload_id)
      : await env.EXPORT_BUCKET.createMultipartUpload(key, {
          httpMetadata: {
            contentType: exportArtifact.contentType,
            contentDisposition: exportArtifact.contentDisposition,
          },
        });
    const encoder = new TextEncoder();
    const compressor = new CompressionStream('gzip');
    let isFinal = false;
    uploadParts = uploadGzipStream({
      stream: compressor.readable,
      partBytes: PART_BYTES,
      startPartNumber: job.next_part_number,
      isFinal: () => isFinal,
      uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
    });
    writer = compressor.writable.getWriter();
    let uncompressedSize = 0;
    let pageCount = 0;
    if (job.next_part_number === 1) {
      const header = encoder.encode(exportHeader(job));
      await writer.write(header);
      uncompressedSize += header.byteLength;
    }
    let cursor = parseCursor(job.source_cursor);
    let recordCount = 0;
    let nextSource: string | null = adapter.name;

    while (
      nextSource &&
      pageCount < MAX_PAGES_PER_INVOCATION &&
      uncompressedSize < MAX_UNCOMPRESSED_BYTES_PER_INVOCATION
    ) {
      const readPage = adapter.readPage;
      if (!readPage) throw new Error('Export job has an invalid current source');
      const page = await readPage({
        kiloUserId: job.kilo_user_id,
        snapshotAt: job.snapshot_at,
        cursor,
        limit: PAGE_SIZE,
      });
      const pagePayload = page.records.map(jsonLine).join('');
      const pageBytes = encoder.encode(pagePayload);
      await writer.write(pageBytes);
      uncompressedSize += pageBytes.byteLength;
      pageCount += 1;
      recordCount += page.records.length;
      if (page.nextCursor) {
        cursor = page.nextCursor;
        nextSource = adapter.name;
        continue;
      }
      const currentIndex = adapters.indexOf(adapter);
      const nextAdapter = adapters.slice(currentIndex + 1).find(item => item.readPage);
      if (!nextAdapter) {
        nextSource = null;
        cursor = null;
        break;
      }
      adapter = nextAdapter;
      cursor = null;
      nextSource = adapter.name;
    }
    isFinal = nextSource === null;
    await writer.close();
    const parts = await uploadParts;
    if (parts.length === 0) throw new Error('Compressed export produced no multipart data');
    const checkpointed = await state.checkpoint({
      exportId: job.id,
      leaseToken,
      parts,
      rowCount: recordCount,
      cursor,
      nextSource,
      nextGeneration: job.dispatch_generation + 1,
      multipartUploadId: upload.uploadId,
    });
    if (!checkpointed) return;

    // Finalization runs from the checkpointed continuation so a crash after the
    // R2 upload cannot complete a multipart object whose part is not durable.
    if (nextSource) return;
  } catch (error) {
    await writer?.abort(error).catch(() => undefined);
    await uploadParts?.catch(() => undefined);
    await state.releaseForRetry(job.id, job.dispatch_generation, leaseToken);
    throw error;
  }
}

async function finalizeExport(
  env: ExportEnv,
  state: ReturnType<typeof createStateDb>,
  job: ExportJob,
  leaseToken: string
): Promise<void> {
  if (!job.multipart_upload_id)
    throw new Error('Final export is missing its multipart upload checkpoint');
  const key = objectKey(job.id);
  let verified = await env.EXPORT_BUCKET.head(key);
  if (!verified) {
    const upload = env.EXPORT_BUCKET.resumeMultipartUpload(key, job.multipart_upload_id);
    const parts = await state.parts(job.id);
    await upload.complete(parts.map(item => ({ partNumber: item.part_number, etag: item.etag })));
    verified = await env.EXPORT_BUCKET.head(key);
  }
  if (!verified) throw new Error('Completed export object was not found');
  await state.complete({
    exportId: job.id,
    leaseToken,
    objectKey: key,
    etag: verified.etag,
    sizeBytes: verified.size,
  });
}

export async function consumeExportBatch(
  batch: MessageBatch<unknown>,
  env: ExportEnv
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = ExportQueueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    try {
      await processGenerateMessage(env, parsed.data);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function consumeDeadLetterBatch(
  batch: { messages: ReadonlyArray<Pick<Message<unknown>, 'body' | 'ack'>> },
  env: ExportEnv,
  state: Pick<ReturnType<typeof createStateDb>, 'markFailed'> = createStateDb(env.PRIMARY_STATE_DB)
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = ExportQueueMessageSchema.safeParse(message.body);
    if (parsed.success) {
      await state.markFailed(parsed.data.exportId, parsed.data.generation);
    }
    message.ack();
  }
}

export async function reconcile(env: ExportEnv): Promise<void> {
  const state = createStateDb(env.PRIMARY_STATE_DB);
  await state.reconcile();
  await deletePendingObjects(env.EXPORT_BUCKET, state);
  for (const item of await state.expiredObjects()) {
    await env.EXPORT_BUCKET.delete(item.r2_object_key);
    await state.markExpired(item.id);
  }
  for (const item of await state.failedMultipartUploads()) {
    const key = objectKey(item.id);
    await env.EXPORT_BUCKET.resumeMultipartUpload(key, item.multipart_upload_id).abort();
    await state.clearMultipartUpload(item.id);
  }
  for (const item of await state.pendingOutbox()) {
    await env.EXPORT_QUEUE.send({
      version: 1,
      operation: 'generate',
      exportId: item.export_id,
      generation: item.generation,
    });
    await state.markOutboxSent(item.id);
  }
  await dispatchReadyNotifications(env, state);
}

export async function deletePendingObjects(
  bucket: Pick<R2Bucket, 'delete'>,
  state: Pick<
    ReturnType<typeof createStateDb>,
    'pendingObjectDeletions' | 'completeObjectDeletion' | 'recordObjectDeletionFailure'
  >
): Promise<void> {
  for (const item of await state.pendingObjectDeletions()) {
    try {
      await bucket.delete(item.object_key);
      await state.completeObjectDeletion(item.object_key);
    } catch {
      await state.recordObjectDeletionFailure(item.object_key);
    }
  }
}

async function dispatchReadyNotifications(
  env: ExportEnv,
  state: ReturnType<typeof createStateDb>
): Promise<void> {
  if (!env.USER_DATA_EXPORT_WEB_URL) return;
  const baseUrl = new URL(env.USER_DATA_EXPORT_WEB_URL);
  if (!isAllowedWebCallbackUrl(env.USER_DATA_EXPORT_WEB_URL)) return;
  const internalApiSecret =
    typeof env.INTERNAL_API_SECRET === 'string'
      ? env.INTERNAL_API_SECRET
      : await env.INTERNAL_API_SECRET.get();

  for (const item of await state.pendingNotifications()) {
    try {
      await fetch(new URL('/api/internal/user-data-exports/ready', baseUrl), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': internalApiSecret,
        },
        body: JSON.stringify({ exportId: item.id }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The database-backed email lease remains authoritative for later sweeps.
    }
  }
}
