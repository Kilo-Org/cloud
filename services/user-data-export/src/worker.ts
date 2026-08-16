import {
  EXPORT_FILE_SCHEMA_VERSION,
  ExportQueueMessageSchema,
  type ExportCursor,
  type ExportQueueMessage,
} from './contracts';
import {
  createReplicaQuery,
  createStateDb,
  type ExportCompletionResult,
  type ExportJob,
  type HyperdriveBinding,
} from './databases';
import { SourceReadError, TerminalExportError } from './errors';
import {
  createSourceAdapters,
  findPresentWarehouseTables,
  warehouseRequirements,
  USER_ONLY_SOURCES,
  type ExportRecord,
  type ExportSubject,
  type SourcePage,
} from './source-adapters';
import type { SourceAdapter } from './source-adapters';
import { uploadGzipStream } from './gzip';
import { classifyFetchFailure, logExportEvent, safeError, withSpan } from './observability';

const MAX_PROCESSING_MS = 13 * 60 * 1000;
const SOURCE_PROCESSING_MS = 12 * 60 * 1000;
const PART_BYTES = 5 * 1024 * 1024;
/**
 * The page size for every source that does not override it, which is every NARROW source:
 * measured row widths there leave a page of this size inside the byte budget. The sources
 * whose rows are large enough for that to matter set `pageSize` themselves, and the budget
 * all of those are derived from is documented beside them in `source-adapters.ts`.
 *
 * Raised from 1,000 on 2026-08-15. A page costs a few hundred milliseconds of fixed round
 * trip before returning a row, so an export's wall clock tracks page COUNT far more than
 * page size, and an organization export was exhausting the 13-minute deadline on round
 * trips alone.
 */
const PAGE_SIZE = 4_000;

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
  /** Export warehouse. Read only, frozen at its load cutoff. */
  EXPORT_WAREHOUSE_DB: HyperdriveBinding;
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

/**
 * The source after this one, or null at the end. One rule, because the failure path and
 * the completion path both advance and must agree on what comes next; when they were
 * written out separately a change to either was a change to only half the loop.
 */
export function nextReadableAdapter(
  adapters: SourceAdapter[],
  from: SourceAdapter
): SourceAdapter | null {
  return adapters.slice(adapters.indexOf(from) + 1).find(item => item.readPage) ?? null;
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

/**
 * The subject a job reads for, derived from persisted state rather than passed in.
 *
 * A row that says 'organization' without an id cannot be scoped to anything, and
 * falling back to the requester would silently hand them a personal export they did
 * not ask for. The database CHECK makes this unreachable; this raises terminally if it
 * ever is, because no retry can add the missing id.
 */
export function exportSubject(job: ExportJob): ExportSubject {
  if (job.subject_type === 'organization') {
    if (!job.organization_id) {
      throw new TerminalExportError(
        'export_subject_incomplete',
        'This export could not be prepared. Please request it again.',
        'Organization export job has no organization_id'
      );
    }
    return { type: 'organization', organizationId: job.organization_id };
  }
  return { type: 'user', kiloUserId: job.kilo_user_id };
}

/**
 * Sources that produce records for a subject, split by whether their table exists.
 *
 * An organization export has no identity section — the warehouse holds no organization
 * record — so `kilocode_users` is dropped from it entirely rather than reported missing.
 * That is a property of the subject, not of the warehouse's load state, and conflating
 * the two would tell an org admin their identity data was unavailable when no such
 * section was ever going to exist. `enrichment_data` is dropped on the same basis: its
 * table carries no organization column at all, so there is no organization reading of it
 * to report as anything.
 *
 * Both are named in `USER_ONLY_SOURCES` rather than checked by name here, so a source
 * that has no organization form says so once, beside the query that lacks one.
 *
 * Everything else is classified by the probe. The warehouse loads table by table and the
 * export ships ahead of it, so a source whose table has not landed is expected.
 */
export function partitionSources(
  adapters: SourceAdapter[],
  subjectType: ExportJob['subject_type'],
  presentTables: Set<string>
): { available: SourceAdapter[]; unavailable: string[] } {
  const applicable = adapters.filter(
    adapter => !(subjectType === 'organization' && USER_ONLY_SOURCES.has(adapter.name))
  );
  const available: SourceAdapter[] = [];
  const unavailable: string[] = [];
  for (const adapter of applicable) {
    if (!adapter.warehouseTable || presentTables.has(adapter.warehouseTable)) {
      available.push(adapter);
    } else {
      unavailable.push(adapter.name);
    }
  }
  return { available, unavailable };
}

export function exportHeader(
  job: ExportJob,
  sources: { available: SourceAdapter[]; unavailable: string[] }
): string {
  return `${JSON.stringify({
    type: 'header',
    schemaVersion: EXPORT_FILE_SCHEMA_VERSION,
    exportId: job.id,
    requestedAt: strictIsoTimestamp(job.requested_at),
    generatedAt: new Date().toISOString(),
    // Names the subject explicitly rather than leaving a consumer to infer it from
    // which sections are present. An organization export and a personal one are
    // otherwise the same shape.
    subjectType: job.subject_type,
    organizationId: job.organization_id,
    includedSources: sources.available.map(adapter => adapter.name),
    // Named rather than silently absent, so "we hold nothing for you here" is
    // distinguishable from "this has not been exported yet". Empty on a complete run.
    unavailableSources: sources.unavailable,
    snapshotAt: strictIsoTimestamp(job.snapshot_at),
  })}\n`;
}

/**
 * The last line of every file, naming any source that failed while being read.
 *
 * A trailer rather than a header field, because the header is written before the first
 * source is read and cannot be amended once a part has been uploaded. A read failure is
 * only knowable afterwards, so the only honest place to record it is at the end.
 *
 * It is written unconditionally, empty list and all. That gives a consumer something the
 * file did not previously have: proof it is complete. A file that ends without a trailer
 * was truncated — the generator died, the deadline fired, R2 rejected a part — and until
 * now that was indistinguishable from a file that simply had no more to say.
 *
 * `failedSources` names the source and nothing else. The underlying error is logged, not
 * exported: a driver message can carry a table name, a column, or a fragment of a query,
 * and none of that belongs in a file handed to the person the export is about.
 */
export function exportTrailer(failedSources: string[]): string {
  return `${JSON.stringify({
    type: 'trailer',
    complete: failedSources.length === 0,
    failedSources,
  })}\n`;
}

export async function processGenerateMessage(
  env: ExportEnv,
  message: ExportQueueMessage
): Promise<void> {
  const state = createStateDb(env.PRIMARY_STATE_DB);
  const leaseToken = crypto.randomUUID();
  const job = await withSpan('export_claim', {}, async span => {
    const claimed = await state.claim(message.exportId, message.generation, leaseToken);
    span.setAttribute('export.claimed', claimed !== null);
    return claimed;
  });
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
      const recovered = await withSpan('export_orphan_cleanup', {}, async span => {
        const cleared = await recoverInterruptedMultipartUpload({
          upload: env.EXPORT_BUCKET.resumeMultipartUpload(objectKey(job.id), multipartUploadId),
          clear: () =>
            state.clearClaimedMultipartUpload({
              exportId: job.id,
              generation: job.dispatch_generation,
              leaseToken,
              multipartUploadId,
            }),
        });
        span.setAttribute('export.lease_retained', cleared);
        return cleared;
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

    // Resolved once, from persisted state, and reused for every page. Deriving it per
    // page would let a single mis-set field change scope midway through a file.
    const subject = exportSubject(job);
    const warehouseQuery = createReplicaQuery(env.EXPORT_WAREHOUSE_DB, 'warehouse');
    const allAdapters = createSourceAdapters({ warehouseQuery });

    // Before anything is written, because the header names what is missing and cannot
    // be amended once the first part has been uploaded. One query, not one per source.
    phase = 'source_probe';
    const sources = await withSpan('export_source_probe', {}, async span => {
      const present = await findPresentWarehouseTables(
        warehouseQuery,
        warehouseRequirements(allAdapters, job.subject_type)
      );
      const partitioned = partitionSources(allAdapters, job.subject_type, present);
      span.setAttribute('export.sources.available', partitioned.available.length);
      span.setAttribute('export.sources.unavailable', partitioned.unavailable.length);
      return partitioned;
    });
    if (sources.unavailable.length > 0) {
      // Expected while the warehouse is still loading, so info rather than warn — but
      // recorded, because it is also how a table silently disappearing would show up.
      logExportEvent('info', 'export_sources_unavailable', {
        exportId: job.id,
        generation: job.dispatch_generation,
        sources: sources.unavailable.join(','),
        sourceCount: sources.unavailable.length,
      });
    }
    const adapters = sources.available;
    if (adapters.length === 0) {
      throw new TerminalExportError(
        'export_no_sources_available',
        'Your data could not be exported right now. Please try again later.',
        'No export source tables are present in the warehouse'
      );
    }

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
    // Bound to a const so the closure below keeps the non-undefined narrowing, matching
    // how activeUpload is captured for the part uploader further down.
    const attachingUpload = upload;
    // R2's createMultipartUpload above is auto-instrumented; the state write that binds
    // the upload id to the job is not, and it is what decides whether this attempt owns
    // the export or has been fenced.
    const attachResult = await withSpan('export_multipart_attach', {}, async span => {
      const result = await attachNewMultipartUpload({
        upload: attachingUpload,
        exportId: job.id,
        generation: job.dispatch_generation,
        leaseToken,
        attach: input => state.attachMultipartUpload(input),
      });
      span.setAttribute('export.attach_result', result);
      return result;
    });
    if (attachResult !== 'attached') return;
    logExportEvent('info', 'export_generation_attempt_started', {
      exportId: job.id,
      generation: job.dispatch_generation,
      source: adapter.name,
      subjectType: job.subject_type,
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
    // Same reason as activeUpload: the spans below are closures, where the non-undefined
    // narrowing on the outer `writer` and `uploadParts` bindings does not survive.
    const activeWriter = writer;
    const activeUploadParts = uploadParts;
    deadline = setTimeout(() => {
      deadlineError = exportDeadlineError();
      void writer?.abort(deadlineError).catch(() => undefined);
    }, MAX_PROCESSING_MS);
    let uncompressedSize = 0;
    let pageCount = 0;
    const header = encoder.encode(exportHeader(job, sources));
    await writer.write(header);
    uncompressedSize += header.byteLength;
    // Annotated because the page span reads this inside a closure, which stops the
    // implicit widening TypeScript would otherwise infer from the assignments below.
    let cursor: ExportCursor | null = null;
    let recordCount = 0;
    // Sources that failed to read. Named in the trailer, so a file says what is missing
    // from it rather than leaving a consumer to infer absence from silence.
    const failedSources: string[] = [];
    // What could be read at all, which is what "everything failed" has to be measured
    // against. See the guard after the loop.
    const readableAdapters = adapters.filter(item => item.readPage);
    let nextSource: string | null = adapter.name;

    while (nextSource) {
      if (Date.now() - processingStartedAt >= SOURCE_PROCESSING_MS) {
        throw deadlineError ?? exportDeadlineError();
      }
      const readPage = adapter.readPage;
      if (!readPage) throw new Error('Export job has an invalid current source');
      phase = 'source_read';
      activeSource = adapter.name;
      // One span per page rather than per source: the loop advances cursors and adapters
      // with continue/break, so a per-source span cannot wrap it without restructuring
      // the control flow. Group by export.source to get per-source totals. The nested
      // postgres_read_page span splits read time from compress-and-write time.
      //
      // Every key below stays a leaf under the export.page object. Setting a scalar at
      // export.page alongside export.page.* silently loses the nested keys, because
      // dotted attribute names are expanded into nested objects on export and a scalar
      // cannot also be an object.
      const pageNumber = pageCount + 1;
      const pageLimit = adapter.pageSize ?? PAGE_SIZE;
      // Captured because the loop reassigns `adapter`, which costs the narrowing inside
      // the closure below.
      const sourceName = adapter.name;
      let page: SourcePage;
      try {
        page = await withSpan(
          'export_source_page',
          { 'export.source': adapter.name, 'export.page.number': pageNumber },
          async span => {
            // Only the read is wrapped: a failure here is one source's problem and the
            // export moves on without it. Everything below writes to the stream, and a
            // stream that cannot be written to is the export's problem, so those throw
            // bare and stay fatal. See `SourceReadError`.
            let result: SourcePage;
            try {
              result = await readPage({
                subject,
                snapshotAt: job.snapshot_at,
                cursor,
                limit: pageLimit,
              });
            } catch (error) {
              // A terminal error is a decision the adapter has already made about the
              // whole export — `kilocode_users` raises one when the subject is absent
              // from the snapshot, carrying the message the requester is meant to see.
              // Wrapping it would demote that to a skipped source and hand back a file
              // missing its identity section with nothing saying why.
              if (error instanceof TerminalExportError) throw error;
              throw new SourceReadError(sourceName, error);
            }
            let pageBytes = 0;
            for (const record of result.records) {
              const recordBytes = encoder.encode(jsonLine(record));
              await activeWriter.write(recordBytes);
              pageBytes += recordBytes.byteLength;
            }
            uncompressedSize += pageBytes;
            // Records, not database rows: an adapter can fan one row out to several
            // records, so this deliberately differs from db.response.returned_rows on the
            // nested read span.
            span.setAttribute('export.page.records', result.records.length);
            span.setAttribute('export.page.uncompressed_bytes', pageBytes);
            span.setAttribute('export.page.has_more', result.nextCursor !== null);
            return result;
          }
        );
      } catch (error) {
        // A deadline is the export's, not a source's, and must not be absorbed here: the
        // loop would carry on past it, one source at a time, until the outer timer fired.
        if (deadlineError) throw deadlineError;
        if (!(error instanceof SourceReadError)) throw error;
        failedSources.push(adapter.name);
        logExportEvent('warn', 'export_source_failed', {
          exportId: job.id,
          generation: job.dispatch_generation,
          source: adapter.name,
          // The error itself never reaches the file; it is recorded here instead.
          ...safeError(error.cause),
        });
        const afterFailed = nextReadableAdapter(adapters, adapter);
        if (!afterFailed) {
          nextSource = null;
          cursor = null;
          break;
        }
        adapter = afterFailed;
        cursor = null;
        nextSource = adapter.name;
        continue;
      }
      pageCount += 1;
      recordCount += page.records.length;
      if (page.nextCursor) {
        cursor = page.nextCursor;
        nextSource = adapter.name;
        continue;
      }
      const nextAdapter = nextReadableAdapter(adapters, adapter);
      if (!nextAdapter) {
        nextSource = null;
        cursor = null;
        break;
      }
      adapter = nextAdapter;
      cursor = null;
      nextSource = adapter.name;
    }
    // Every source failing is not a partial export, it is a broken one. Completing here
    // would hand someone an empty file that claims to be their data, which is a worse
    // outcome than the failure the retry path exists for.
    //
    // Counted against the READABLE adapters rather than all of them. `readPage` is
    // optional on the type and every other advance here filters on it, so comparing
    // against the full list would let a single reader-less adapter make this condition
    // unreachable and turn a total failure into a silently empty file.
    if (failedSources.length > 0 && failedSources.length === readableAdapters.length) {
      throw new Error('Every export source failed to read');
    }
    const trailer = encoder.encode(exportTrailer(failedSources));
    await writer.write(trailer);
    uncompressedSize += trailer.byteLength;
    phase = 'compression_finalize';
    // Draining the compressor is where any part uploads still in flight are awaited, so
    // this span is the wait-on-R2 tail of the export rather than compression cost alone.
    const parts = await withSpan('export_compression_finalize', {}, async span => {
      await activeWriter.close();
      const uploaded = await activeUploadParts;
      span.setAttribute('export.parts', uploaded.length);
      return uploaded;
    });
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
    const completion = await withSpan(
      'export_state_update',
      { 'export.rows': recordCount, 'export.size_bytes': object.size },
      async span => {
        const result = await persistCompletedExport({
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
        span.setAttribute('export.completion', result);
        return result;
      }
    );
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
      // Wrapped here rather than inside processGenerateMessage so the span covers the
      // whole attempt, including the retry decision below, and so every span the
      // generator opens inherits the export id and attempt number as ancestors.
      await withSpan(
        'export_generate',
        {
          'export.id': parsed.data.exportId,
          'export.generation': parsed.data.generation,
          'export.attempt': message.attempts,
        },
        () => processMessage(env, parsed.data)
      );
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

/**
 * The cron runs every five minutes and its four stages are sequential, so without spans
 * per stage a slow sweep is indistinguishable from a slow lease expiry query.
 */
export async function reconcile(env: ExportEnv): Promise<void> {
  const state = createStateDb(env.PRIMARY_STATE_DB);
  await withSpan('reconcile_leases', {}, () => state.reconcile());
  await withSpan('reconcile_object_deletions', {}, () =>
    deletePendingObjects(env.EXPORT_BUCKET, state)
  );
  await withSpan('reconcile_scheduled_work', {}, () => processScheduledExportWork(env, state));
  await withSpan('reconcile_notifications', {}, () => dispatchReadyNotifications(env, state));
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
