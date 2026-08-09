import { ExportQueueMessageSchema, type ExportQueueMessage, parseCursor } from './contracts';
import {
  createReplicaQuery,
  createStateDb,
  type ExportJob,
  type HyperdriveBinding,
} from './databases';
import { uploadGzipStream } from './gzip';
import { createSourceAdapters, type ExportRecord } from './source-adapters';
import type { SourceAdapter } from './source-adapters';

const PART_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES_PER_INVOCATION = 32 * 1024 * 1024;
const MAX_PAGES_PER_INVOCATION = 200;
const PAGE_SIZE = 100;

export type ExportEnv = {
  PRIMARY_STATE_DB: HyperdriveBinding;
  EXPORT_REPLICA_DB: HyperdriveBinding;
  EXPORT_BUCKET: R2Bucket;
  EXPORT_QUEUE: Queue<ExportQueueMessage>;
  INTERNAL_API_SECRET: string;
  NEXTAUTH_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
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
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' &&
        (url.hostname === 'app.kilo.ai' || url.hostname === 'staging-app.kilo.ai')) ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    );
  } catch {
    return false;
  }
}

export function resolveSourceAdapter(
  adapters: SourceAdapter[],
  persistedSource: string | null
): SourceAdapter | undefined {
  return persistedSource === null
    ? adapters.find(adapter => adapter.readPage)
    : adapters.find(adapter => adapter.name === persistedSource);
}

export async function attachNewMultipartUpload(input: {
  upload: Pick<R2MultipartUpload, 'uploadId' | 'abort'>;
  exportId: string;
  generation: number;
  leaseToken: string;
  attach: (input: {
    exportId: string;
    generation: number;
    leaseToken: string;
    multipartUploadId: string;
  }) => Promise<'attached' | 'deleted' | 'lost_lease'>;
}): Promise<'attached' | 'deleted' | 'lost_lease'> {
  try {
    const result = await input.attach({
      exportId: input.exportId,
      generation: input.generation,
      leaseToken: input.leaseToken,
      multipartUploadId: input.upload.uploadId,
    });
    if (result !== 'attached') await input.upload.abort();
    return result;
  } catch (error) {
    await input.upload.abort().catch(() => undefined);
    throw error;
  }
}

export async function dispatchContinuation(input: {
  queue: Pick<Queue<ExportQueueMessage>, 'send'>;
  exportId: string;
  generation: number;
  markSent: (exportId: string, generation: number) => Promise<void>;
}): Promise<void> {
  try {
    await input.queue.send({
      version: 1,
      operation: 'generate',
      exportId: input.exportId,
      generation: input.generation,
    });
    await input.markSent(input.exportId, input.generation);
  } catch {
    // The transactional outbox remains available for scheduled recovery.
  }
}

function jsonLine(record: ExportRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function strictIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export function exportHeader(job: ExportJob): string {
  return `${JSON.stringify({
    type: 'header',
    schemaVersion: 1,
    exportId: job.id,
    requestedAt: strictIsoTimestamp(job.requested_at),
    generatedAt: new Date().toISOString(),
    includedSources: [
      'kilocode_users',
      'app_builder_projects',
      'microdollar_usage_metadata',
      'system_prompt_prefix',
    ],
    snapshotAt: strictIsoTimestamp(job.snapshot_at),
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
    let adapter = resolveSourceAdapter(adapters, job.current_source);
    if (!adapter || !adapter.readPage) {
      throw new Error('Export job has an invalid current source');
    }

    const key = objectKey(job.id);
    let upload: R2MultipartUpload;
    if (job.multipart_upload_id) {
      upload = env.EXPORT_BUCKET.resumeMultipartUpload(key, job.multipart_upload_id);
    } else {
      upload = await env.EXPORT_BUCKET.createMultipartUpload(key, {
        httpMetadata: {
          contentType: exportArtifact.contentType,
          contentDisposition: exportArtifact.contentDisposition,
        },
      });
      const attachResult = await attachNewMultipartUpload({
        upload,
        exportId: job.id,
        generation: job.dispatch_generation,
        leaseToken,
        attach: input => state.attachMultipartUpload(input),
      });
      if (attachResult !== 'attached') return;
    }
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

    await dispatchContinuation({
      queue: env.EXPORT_QUEUE,
      exportId: job.id,
      generation: job.dispatch_generation + 1,
      markSent: (exportId, generation) => state.markOutboxGenerationSent(exportId, generation),
    });

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
  await processScheduledExportWork(env, state);
  await dispatchReadyNotifications(env, state);
}

export async function processScheduledExportWork(
  env: {
    EXPORT_BUCKET: Pick<R2Bucket, 'delete' | 'resumeMultipartUpload'>;
    EXPORT_QUEUE: Pick<Queue<ExportQueueMessage>, 'send'>;
  },
  state: Pick<
    ReturnType<typeof createStateDb>,
    | 'expiredObjects'
    | 'markExpired'
    | 'failedMultipartUploads'
    | 'clearMultipartUpload'
    | 'pendingOutbox'
    | 'markOutboxSent'
    | 'recordOutboxFailure'
  >
): Promise<void> {
  for (const item of await state.expiredObjects()) {
    try {
      await env.EXPORT_BUCKET.delete(item.r2_object_key);
      await state.markExpired(item.id);
    } catch {
      console.warn(JSON.stringify({ event: 'export_expiry_cleanup_failed', exportId: item.id }));
    }
  }
  for (const item of await state.failedMultipartUploads()) {
    try {
      const key = objectKey(item.id);
      await env.EXPORT_BUCKET.resumeMultipartUpload(key, item.multipart_upload_id).abort();
      await state.clearMultipartUpload(item.id);
    } catch {
      console.warn(
        JSON.stringify({ event: 'failed_export_multipart_cleanup_failed', exportId: item.id })
      );
    }
  }
  for (const item of await state.pendingOutbox()) {
    try {
      await env.EXPORT_QUEUE.send({
        version: 1,
        operation: 'generate',
        exportId: item.export_id,
        generation: item.generation,
      });
      await state.markOutboxSent(item.id);
    } catch {
      await state.recordOutboxFailure(item.id);
      console.warn(
        JSON.stringify({
          event: 'export_outbox_dispatch_failed',
          exportId: item.export_id,
          generation: item.generation,
        })
      );
    }
  }
}

export async function deletePendingObjects(
  bucket: Pick<R2Bucket, 'delete' | 'resumeMultipartUpload'>,
  state: Pick<
    ReturnType<typeof createStateDb>,
    'pendingObjectDeletions' | 'completeObjectDeletion' | 'recordObjectDeletionFailure'
  >
): Promise<void> {
  for (const item of await state.pendingObjectDeletions()) {
    try {
      if (item.multipart_upload_id) {
        try {
          await bucket.resumeMultipartUpload(item.object_key, item.multipart_upload_id).abort();
        } catch (error) {
          const value = error as { code?: number; name?: string };
          if (value.code !== 10024 && value.name !== 'NoSuchUpload') throw error;
        }
      }
      await bucket.delete(item.object_key);
      await state.completeObjectDeletion(item.object_key);
    } catch {
      await state.recordObjectDeletionFailure(item.object_key);
      console.warn(
        JSON.stringify({
          event: 'account_export_object_cleanup_failed',
          objectKey: item.object_key,
        })
      );
    }
  }
}

async function dispatchReadyNotifications(
  env: ExportEnv,
  state: ReturnType<typeof createStateDb>
): Promise<void> {
  if (!env.USER_DATA_EXPORT_WEB_URL) return;
  if (!isAllowedWebCallbackUrl(env.USER_DATA_EXPORT_WEB_URL)) {
    console.warn(JSON.stringify({ event: 'export_notification_callback_url_invalid' }));
    return;
  }
  const baseUrl = new URL(env.USER_DATA_EXPORT_WEB_URL);
  for (const item of await state.pendingNotifications()) {
    try {
      await fetch(new URL('/api/internal/user-data-exports/ready', baseUrl), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': env.INTERNAL_API_SECRET,
        },
        body: JSON.stringify({ exportId: item.id }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The database-backed email lease remains authoritative for later sweeps.
    }
  }
}
