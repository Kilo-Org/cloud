import { ExportQueueMessageSchema, type ExportQueueMessage } from './contracts';
import {
  createReplicaQuery,
  createStateDb,
  type ExportCompletionResult,
  type ExportJob,
  type HyperdriveBinding,
} from './databases';
import { createSourceAdapters, type ExportRecord } from './source-adapters';
import type { SourceAdapter } from './source-adapters';
import { uploadGzipStream } from './gzip';
import { classifyFetchFailure, logExportEvent, safeError } from './observability';

const MAX_PROCESSING_MS = 13 * 60 * 1000;
const SOURCE_PROCESSING_MS = 12 * 60 * 1000;
const PART_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 1_000;

export class TerminalExportError extends Error {
  constructor(
    readonly failureCode: string,
    readonly redactedMessage: string,
    message: string
  ) {
    super(message);
    this.name = 'TerminalExportError';
  }
}

function exportDeadlineError(): TerminalExportError {
  return new TerminalExportError(
    'export_deadline_exceeded',
    'The export was too large to complete within the processing limit.',
    'Export exceeded the 13-minute processing deadline'
  );
}

export function hasRetiredGeneratorState(
  job: Pick<ExportJob, 'current_source' | 'source_cursor' | 'next_part_number'>
): boolean {
  return job.current_source !== null || job.source_cursor !== null || job.next_part_number !== 1;
}

export async function handleGenerationFailure(input: {
  error: unknown;
  exportId: string;
  generation: number;
  leaseToken: string;
  phase: string;
  source: string | null;
  markFailed: (input: {
    exportId: string;
    generation: number;
    leaseToken: string;
    failureCode: string;
    redactedMessage: string;
  }) => Promise<void>;
  releaseForRetry: (exportId: string, generation: number, leaseToken: string) => Promise<void>;
}): Promise<'failed' | 'retry'> {
  if (input.error instanceof TerminalExportError) {
    await input.markFailed({
      exportId: input.exportId,
      generation: input.generation,
      leaseToken: input.leaseToken,
      failureCode: input.error.failureCode,
      redactedMessage: input.error.redactedMessage,
    });
    logExportEvent('error', 'export_generation_failed', {
      exportId: input.exportId,
      generation: input.generation,
      phase: input.phase,
      source: input.source,
      terminal: true,
      ...safeError(input.error),
    });
    return 'failed';
  }

  await input.releaseForRetry(input.exportId, input.generation, input.leaseToken);
  logExportEvent('error', 'export_generation_failed', {
    exportId: input.exportId,
    generation: input.generation,
    phase: input.phase,
    source: input.source,
    terminal: false,
    ...safeError(input.error),
  });
  return 'retry';
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

function isMissingMultipartUpload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; name?: unknown };
  return value.code === 10024 || value.name === 'NoSuchUpload';
}

async function abortMultipartUpload(upload: Pick<R2MultipartUpload, 'abort'>): Promise<void> {
  try {
    await upload.abort();
  } catch (error) {
    if (!isMissingMultipartUpload(error)) throw error;
  }
}

export const exportArtifact = {
  contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
  contentType: 'application/gzip',
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

export async function recoverInterruptedMultipartUpload(input: {
  upload: Pick<R2MultipartUpload, 'abort'>;
  clear: () => Promise<boolean>;
}): Promise<boolean> {
  await abortMultipartUpload(input.upload);
  return input.clear();
}
export async function persistCompletedExport(input: {
  complete: () => Promise<ExportCompletionResult>;
  completedObjectMatches: () => Promise<boolean>;
}): Promise<ExportCompletionResult> {
  try {
    return await input.complete();
  } catch (error) {
    if (await input.completedObjectMatches()) return 'already_completed';
    throw error;
  }
}

export async function handleFencedCompletion(input: {
  exportId: string;
  generation: number;
  scheduleObjectDeletion: () => Promise<boolean>;
}): Promise<boolean> {
  const cleanupScheduled = await input.scheduleObjectDeletion();
  logExportEvent('warn', 'export_completion_fenced', {
    exportId: input.exportId,
    generation: input.generation,
    reason: 'lost_lease_or_terminal_state',
    cleanupScheduled,
  });
  return cleanupScheduled;
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
  let upload: R2MultipartUpload | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let deadlineError: TerminalExportError | undefined;
  let objectCompletionAttempted = false;
  let phase = 'claim';
  let activeSource = job.current_source;

  try {
    if (hasRetiredGeneratorState(job)) {
      throw new TerminalExportError(
        'retired_multipart_export',
        'This export was created by an older generator and must be requested again.',
        'Existing multipart export cannot be resumed by the one-shot generator'
      );
    }

    if (job.multipart_upload_id) {
      const multipartUploadId = job.multipart_upload_id;
      phase = 'orphan_cleanup';
      const recovered = await recoverInterruptedMultipartUpload({
        upload: env.EXPORT_BUCKET.resumeMultipartUpload(objectKey(job.id), multipartUploadId),
        clear: () =>
          state.clearClaimedMultipartUpload({
            exportId: job.id,
            generation: job.dispatch_generation,
            leaseToken,
            multipartUploadId,
          }),
      });
      if (!recovered) {
        logExportEvent('info', 'export_generation_skipped', {
          exportId: job.id,
          generation: job.dispatch_generation,
          reason: 'lost_lease_during_orphan_cleanup',
        });
        return;
      }
      job.multipart_upload_id = null;
      phase = 'claim';
    }

    const adapters = createSourceAdapters(createReplicaQuery(env.EXPORT_REPLICA_DB));
    let adapter = resolveSourceAdapter(adapters, job.current_source);
    if (!adapter || !adapter.readPage) {
      throw new Error('Export job has an invalid current source');
    }
    activeSource = adapter.name;

    const key = objectKey(job.id);
    phase = 'multipart';
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
    logExportEvent('info', 'export_generation_attempt_started', {
      exportId: job.id,
      generation: job.dispatch_generation,
      source: adapter.name,
      uploadMode: 'single_invocation_multipart',
    });
    const encoder = new TextEncoder();
    const compressor = new CompressionStream('gzip');
    const processingStartedAt = Date.now();
    const activeUpload = upload;
    uploadParts = uploadGzipStream({
      stream: compressor.readable,
      partBytes: PART_BYTES,
      uploadPart: (partNumber, value) => activeUpload.uploadPart(partNumber, value),
    });
    writer = compressor.writable.getWriter();
    deadline = setTimeout(() => {
      deadlineError = exportDeadlineError();
      void writer?.abort(deadlineError).catch(() => undefined);
    }, MAX_PROCESSING_MS);
    let uncompressedSize = 0;
    let pageCount = 0;
    const header = encoder.encode(exportHeader(job));
    await writer.write(header);
    uncompressedSize += header.byteLength;
    let cursor = null;
    let recordCount = 0;
    let nextSource: string | null = adapter.name;

    while (nextSource) {
      if (Date.now() - processingStartedAt >= SOURCE_PROCESSING_MS) {
        throw deadlineError ?? exportDeadlineError();
      }
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
      for (const record of page.records) {
        const recordBytes = encoder.encode(jsonLine(record));
        await writer.write(recordBytes);
        uncompressedSize += recordBytes.byteLength;
      }
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
    phase = 'compression_finalize';
    await writer.close();
    const parts = await uploadParts;
    if (parts.length === 0) throw new Error('Compressed export produced no multipart data');
    if (deadlineError) throw deadlineError;
    if (deadline) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    phase = 'object_finalize';
    objectCompletionAttempted = true;
    const object = await upload.complete(
      parts.map(part => ({ partNumber: part.partNumber, etag: part.etag }))
    );
    phase = 'state_update';
    const completion = await persistCompletedExport({
      complete: () =>
        state.complete({
          exportId: job.id,
          leaseToken,
          rowCount: recordCount,
          objectKey: key,
          etag: object.etag,
          sizeBytes: object.size,
        }),
      completedObjectMatches: () =>
        state.completedObjectMatches({ exportId: job.id, objectKey: key, etag: object.etag }),
    });
    if (completion === 'fenced') {
      await handleFencedCompletion({
        exportId: job.id,
        generation: job.dispatch_generation,
        scheduleObjectDeletion: () =>
          state.scheduleTerminalObjectDeletion({ exportId: job.id, objectKey: key }),
      });
      return;
    }

    logExportEvent('info', 'export_completed', {
      exportId: job.id,
      generation: job.dispatch_generation,
      pageCount,
      rowCount: recordCount,
      uncompressedBytes: uncompressedSize,
      sizeBytes: object.size,
    });
  } catch (error) {
    const failure = deadlineError ?? error;
    await writer?.abort(failure).catch(() => undefined);
    await uploadParts?.catch(() => undefined);
    if (upload && !objectCompletionAttempted) {
      try {
        await abortMultipartUpload(upload);
        await state.clearClaimedMultipartUpload({
          exportId: job.id,
          generation: job.dispatch_generation,
          leaseToken,
          multipartUploadId: upload.uploadId,
        });
      } catch {
        // Preserve multipart_upload_id so reclaim or scheduled cleanup can retry the abort.
      }
    }
    const outcome = await handleGenerationFailure({
      error: failure,
      exportId: job.id,
      generation: job.dispatch_generation,
      leaseToken,
      phase,
      source: activeSource,
      markFailed: input => state.markLeasedExportFailed(input),
      releaseForRetry: (exportId, generation, token) =>
        state.releaseForRetry(exportId, generation, token),
    });
    if (outcome === 'retry') throw failure;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
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
      await abortMultipartUpload(
        env.EXPORT_BUCKET.resumeMultipartUpload(key, item.multipart_upload_id)
      );
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
          if (!isMissingMultipartUpload(error)) throw error;
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
