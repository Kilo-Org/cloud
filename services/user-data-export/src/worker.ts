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
import { classifyFetchFailure, logExportEvent, safeError } from './observability';

const PART_BYTES = 5 * 1024 * 1024;
const MAX_PROCESSING_MS = 10 * 60 * 1000;
const PAGE_SIZE = 1_000;

export function hasProcessingTimeRemaining(startedAt: number, now: number = Date.now()): boolean {
  return now - startedAt < MAX_PROCESSING_MS;
}

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

function exportIdFromObjectKey(value: string): string | undefined {
  return /^exports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/kilo-data-export\.jsonl\.gz$/i.exec(
    value
  )?.[1];
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
      (url.protocol === 'https:' && url.hostname === 'api.kilo.ai') ||
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
    logExportEvent('info', 'export_continuation_dispatched', {
      exportId: input.exportId,
      generation: input.generation,
    });
  } catch (error) {
    // The transactional outbox remains available for scheduled recovery.
    logExportEvent('warn', 'export_continuation_deferred', {
      exportId: input.exportId,
      generation: input.generation,
      ...safeError(error),
    });
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
  if (!job) {
    logExportEvent('info', 'export_generation_skipped', {
      exportId: message.exportId,
      generation: message.generation,
      reason: 'not_claimable',
    });
    return;
  }
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let uploadParts:
    | Promise<Array<{ partNumber: number; etag: string; sizeBytes: number }>>
    | undefined;
  let phase = 'claim';
  let activeSource = job.current_source;

  try {
    if (job.current_source === null && job.multipart_upload_id) {
      phase = 'finalization';
      logExportEvent('info', 'export_finalization_started', {
        exportId: job.id,
        generation: job.dispatch_generation,
        nextPartNumber: job.next_part_number,
      });
      await finalizeExport(env, state, job, leaseToken);
      return;
    }

    const adapters = createSourceAdapters(createReplicaQuery(env.EXPORT_REPLICA_DB));
    let adapter = resolveSourceAdapter(adapters, job.current_source);
    if (!adapter || !adapter.readPage) {
      throw new Error('Export job has an invalid current source');
    }
    activeSource = adapter.name;

    const key = objectKey(job.id);
    phase = 'multipart';
    let upload: R2MultipartUpload;
    if (job.multipart_upload_id) {
      upload = env.EXPORT_BUCKET.resumeMultipartUpload(key, job.multipart_upload_id);
      logExportEvent('info', 'export_generation_attempt_started', {
        exportId: job.id,
        generation: job.dispatch_generation,
        source: adapter.name,
        uploadMode: 'resumed',
        nextPartNumber: job.next_part_number,
      });
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
      if (attachResult !== 'attached') {
        logExportEvent('info', 'export_generation_skipped', {
          exportId: job.id,
          generation: job.dispatch_generation,
          reason: attachResult,
        });
        return;
      }
      logExportEvent('info', 'export_generation_attempt_started', {
        exportId: job.id,
        generation: job.dispatch_generation,
        source: adapter.name,
        uploadMode: 'created',
        nextPartNumber: job.next_part_number,
      });
    }
    const encoder = new TextEncoder();
    const compressor = new CompressionStream('gzip');
    const processingStartedAt = Date.now();
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

    while (nextSource && hasProcessingTimeRemaining(processingStartedAt)) {
      const readPage = adapter.readPage;
      if (!readPage) throw new Error('Export job has an invalid current source');
      phase = 'source_read';
      activeSource = adapter.name;
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
    phase = 'compression_finalize';
    await writer.close();
    const parts = await uploadParts;
    if (parts.length === 0) throw new Error('Compressed export produced no multipart data');
    phase = 'checkpoint';
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
    if (!checkpointed) {
      logExportEvent('warn', 'export_checkpoint_rejected', {
        exportId: job.id,
        generation: job.dispatch_generation,
      });
      return;
    }

    logExportEvent('info', 'export_generation_checkpointed', {
      exportId: job.id,
      generation: job.dispatch_generation,
      nextGeneration: job.dispatch_generation + 1,
      source: adapter.name,
      nextSource,
      pageCount,
      rowCount: recordCount,
      partCount: parts.length,
      uncompressedBytes: uncompressedSize,
    });

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
    logExportEvent('error', 'export_generation_failed', {
      exportId: job.id,
      generation: job.dispatch_generation,
      phase,
      source: activeSource,
      ...safeError(error),
    });
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
  const completed = await state.complete({
    exportId: job.id,
    leaseToken,
    objectKey: key,
    etag: verified.etag,
    sizeBytes: verified.size,
  });
  if (!completed) {
    logExportEvent('warn', 'export_completion_fenced', {
      exportId: job.id,
      generation: job.dispatch_generation,
      reason: 'lost_lease_or_terminal_state',
    });
    return;
  }
  logExportEvent('info', 'export_completed', {
    exportId: job.id,
    generation: job.dispatch_generation,
    sizeBytes: verified.size,
  });
}

export async function consumeExportBatch(
  batch: MessageBatch<unknown>,
  env: ExportEnv,
  processMessage: (
    env: ExportEnv,
    message: ExportQueueMessage
  ) => Promise<void> = processGenerateMessage
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = ExportQueueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      logExportEvent('warn', 'export_queue_message_invalid', {
        validationIssueCount: parsed.error.issues.length,
      });
      message.ack();
      continue;
    }
    try {
      await processMessage(env, parsed.data);
      message.ack();
    } catch (error) {
      logExportEvent('warn', 'export_queue_retry_requested', {
        exportId: parsed.data.exportId,
        generation: parsed.data.generation,
        attempt: message.attempts,
        ...safeError(error),
      });
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
      logExportEvent('error', 'export_message_dead_lettered', {
        exportId: parsed.data.exportId,
        generation: parsed.data.generation,
      });
    } else {
      logExportEvent('error', 'export_dead_letter_message_invalid', {
        validationIssueCount: parsed.error.issues.length,
      });
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
    let stage = 'r2_delete';
    try {
      await env.EXPORT_BUCKET.delete(item.r2_object_key);
      stage = 'state_update';
      await state.markExpired(item.id);
      logExportEvent('info', 'export_expired_object_deleted', { exportId: item.id });
    } catch (error) {
      logExportEvent('warn', 'export_expiry_cleanup_failed', {
        exportId: item.id,
        stage,
        ...safeError(error),
      });
    }
  }
  for (const item of await state.failedMultipartUploads()) {
    let stage = 'multipart_abort';
    try {
      const key = objectKey(item.id);
      await env.EXPORT_BUCKET.resumeMultipartUpload(key, item.multipart_upload_id).abort();
      stage = 'state_update';
      await state.clearMultipartUpload(item.id);
      logExportEvent('info', 'failed_export_multipart_deleted', { exportId: item.id });
    } catch (error) {
      logExportEvent('warn', 'failed_export_multipart_cleanup_failed', {
        exportId: item.id,
        stage,
        ...safeError(error),
      });
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
      logExportEvent('info', 'export_outbox_dispatched', {
        exportId: item.export_id,
        generation: item.generation,
      });
    } catch (error) {
      await state.recordOutboxFailure(item.id);
      logExportEvent('warn', 'export_outbox_dispatch_failed', {
        exportId: item.export_id,
        generation: item.generation,
        ...safeError(error),
      });
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
    const exportId = exportIdFromObjectKey(item.object_key);
    let stage = item.multipart_upload_id ? 'multipart_abort' : 'r2_delete';
    try {
      if (item.multipart_upload_id) {
        try {
          await bucket.resumeMultipartUpload(item.object_key, item.multipart_upload_id).abort();
        } catch (error) {
          const value = error as { code?: number; name?: string };
          if (value.code !== 10024 && value.name !== 'NoSuchUpload') throw error;
        }
      }
      stage = 'r2_delete';
      await bucket.delete(item.object_key);
      stage = 'state_update';
      await state.completeObjectDeletion(item.object_key);
      logExportEvent('info', 'account_export_object_deleted', { exportId });
    } catch (error) {
      await state.recordObjectDeletionFailure(item.object_key);
      logExportEvent('warn', 'account_export_object_cleanup_failed', {
        exportId,
        stage,
        ...safeError(error),
      });
    }
  }
}

/**
 * Extract only the host of a redirect target for diagnostics. Never returns the
 * path or query (which could carry tokens), and never causes the redirect to be
 * followed.
 */
export function redirectTargetHost(response: Response, requestUrl: URL): string {
  const location = response.headers.get('location');
  if (!location) return 'unknown';
  try {
    return new URL(location, requestUrl).host;
  } catch {
    return 'unparseable';
  }
}

async function dispatchReadyNotifications(
  env: ExportEnv,
  state: ReturnType<typeof createStateDb>
): Promise<void> {
  if (!env.USER_DATA_EXPORT_WEB_URL) return;
  if (!isAllowedWebCallbackUrl(env.USER_DATA_EXPORT_WEB_URL)) {
    logExportEvent('warn', 'export_notification_callback_url_invalid');
    return;
  }
  const baseUrl = new URL(env.USER_DATA_EXPORT_WEB_URL);
  const callbackUrl = new URL('/api/internal/user-data-exports/ready', baseUrl);
  for (const item of await state.pendingNotifications()) {
    try {
      // redirect: 'manual' is fail-closed — we never follow a redirect and therefore
      // never re-send x-internal-api-key to the redirect target. We still capture the
      // redirect's target host (no path/query, so no secrets) to diagnose an
      // unexpected 3xx on the api.kilo.ai callback path.
      const response = await fetch(callbackUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': env.INTERNAL_API_SECRET,
        },
        body: JSON.stringify({ exportId: item.id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        logExportEvent('warn', 'export_notification_callback_failed', {
          exportId: item.id,
          reason: 'redirect',
          status: response.status,
          redirectHost: redirectTargetHost(response, callbackUrl),
        });
        continue;
      }
      logExportEvent(response.ok ? 'info' : 'warn', 'export_notification_callback_completed', {
        exportId: item.id,
        status: response.status,
      });
    } catch (error) {
      // The database-backed email lease remains authoritative for later sweeps.
      // reason distinguishes a disallowed redirect / timeout / dropped connection,
      // which safeError alone flattens into an opaque TypeError.
      logExportEvent('warn', 'export_notification_callback_failed', {
        exportId: item.id,
        reason: classifyFetchFailure(error),
        ...safeError(error),
      });
    }
  }
}
