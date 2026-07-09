import { withDORetry } from '@kilocode/worker-utils';

import { getSessionIngestDO, type IngestResult } from '../dos/SessionIngestDO';
import type { Env } from '../env';
import {
  INGEST_CHUNK_MAX_BYTES,
  INGEST_CHUNK_MAX_ITEMS,
  MAX_INGEST_ITEM_BYTES,
} from '../util/ingest-limits';
import { readBoundedStream } from './bounded-stream-reader';
import { parseDirectIngestConfig, selectDirectIngestUser } from './direct-ingest-rollout';
import { applyMetadataChanges } from './metadata';
import {
  StageAndEnqueueError,
  stageAndEnqueue,
  type StageAndEnqueueFailureStage,
} from './stage-and-enqueue';
import { validateAndParseIngestPayload } from './validate';

type DirectIngestContext = { waitUntil(promise: Promise<unknown>): void };

export type DirectIngestRequest = {
  env: Env;
  body: ReadableStream<Uint8Array>;
  contentLength: string | undefined;
  kiloUserId: string;
  sessionId: string;
  ingestVersion: number;
  ingestedAt: number;
  ingestRequestId: string;
  executionContext?: DirectIngestContext;
};

export type DirectIngestResponse =
  | { status: 200; body: { success: true } }
  | { status: 400; body: { success: false; error: 'malformed_json' } }
  | { status: 404; body: { success: false; error: 'session_not_found' } }
  | { status: 413; body: { success: false; error: 'payload_too_large' } };

type LegacyReason =
  | 'gate_config'
  | 'gate_percent'
  | 'no_content_length'
  | 'invalid_content_length'
  | 'oversized_body'
  | 'oversized_item'
  | 'multi_chunk';

type CommonEvent = {
  ingestRequestId: string;
  sessionId: string;
  ingestVersion: number;
  declaredBytes: number | null;
  actualBytes: number | null;
  durationMs: number;
  items: number | null;
};

const contentLengthPattern = /^(0|[1-9]\d*)$/;

export async function handleDirectIngestRequest(
  request: DirectIngestRequest
): Promise<DirectIngestResponse> {
  const startedAt = performance.now();
  const baseEvent = {
    ingestRequestId: request.ingestRequestId,
    sessionId: request.sessionId,
    ingestVersion: request.ingestVersion,
  };
  const r2Key = `ingest/${request.kiloUserId}/${request.sessionId}/${request.ingestRequestId}`;
  const configResult = parseDirectIngestConfig(request.env);

  if (!configResult.ok) {
    console.error({ event: 'direct_ingest_config_error', reason: configResult.reason });
    return legacy(request, r2Key, request.body, 'gate_config', null, null, null, startedAt);
  }

  let selection;
  try {
    selection = await selectDirectIngestUser(configResult.config, request.kiloUserId);
  } catch (error) {
    console.error({
      event: 'direct_ingest_config_error',
      reason: 'bucket_failure',
      error: errorMessage(error),
    });
    return legacy(request, r2Key, request.body, 'gate_config', null, null, null, startedAt);
  }
  if (!selection.selected) {
    return legacy(request, r2Key, request.body, 'gate_percent', null, null, null, startedAt);
  }

  const contentLength = parseContentLength(request.contentLength);
  if (contentLength === 'missing') {
    return legacy(request, r2Key, request.body, 'no_content_length', null, null, null, startedAt);
  }
  if (contentLength === 'invalid') {
    return legacy(
      request,
      r2Key,
      request.body,
      'invalid_content_length',
      null,
      null,
      null,
      startedAt
    );
  }
  if (contentLength > configResult.config.maxBytes) {
    return legacy(
      request,
      r2Key,
      request.body,
      'oversized_body',
      contentLength,
      null,
      null,
      startedAt
    );
  }

  const buffered = await readBoundedStream(
    request.body,
    contentLength,
    configResult.config.maxBytes
  );
  if (!buffered.ok) {
    logEvent('warn', {
      event: 'direct_ingest_legacy',
      ...baseEvent,
      reason: 'oversized_body',
      declaredBytes: contentLength,
      actualBytes: null,
      durationMs: elapsed(startedAt),
      items: null,
    });
    return { status: 413, body: { success: false, error: 'payload_too_large' } };
  }

  const actualBytes = buffered.bytes.byteLength;
  const validation = validateAndParseIngestPayload(buffered.bytes);
  if (!validation.ok) {
    logEvent('warn', {
      event: 'direct_ingest_parse_reject',
      ...baseEvent,
      declaredBytes: contentLength,
      actualBytes,
      durationMs: elapsed(startedAt),
      items: null,
    });
    return { status: 400, body: { success: false, error: 'malformed_json' } };
  }

  if (validation.skippedItemCount > 0) {
    console.warn({
      event: 'direct_ingest_items_skipped',
      ingestRequestId: request.ingestRequestId,
      sessionId: request.sessionId,
      skippedItems: validation.skippedItemCount,
    });
  }

  if (validation.dataArray !== 'present' || validation.validItemCount === 0) {
    logEvent('info', {
      event: 'direct_ingest_ok',
      ...baseEvent,
      declaredBytes: contentLength,
      actualBytes,
      durationMs: elapsed(startedAt),
      items: 0,
      metadataChanges: 0,
    });
    return { status: 200, body: { success: true } };
  }

  if (validation.maxValidItemBytes > MAX_INGEST_ITEM_BYTES) {
    return legacy(
      request,
      r2Key,
      buffered.bytes,
      'oversized_item',
      contentLength,
      actualBytes,
      validation.validItemCount,
      startedAt
    );
  }
  if (
    validation.validItemCount > INGEST_CHUNK_MAX_ITEMS ||
    validation.totalValidItemBytes > INGEST_CHUNK_MAX_BYTES
  ) {
    return legacy(
      request,
      r2Key,
      buffered.bytes,
      'multi_chunk',
      contentLength,
      actualBytes,
      validation.validItemCount,
      startedAt
    );
  }

  let ingestResult: IngestResult;
  try {
    ingestResult = await withDORetry<ReturnType<typeof getSessionIngestDO>, IngestResult>(
      () => getSessionIngestDO(request.env, request),
      async stub =>
        stub.ingest(
          validation.items,
          request.kiloUserId,
          request.sessionId,
          request.ingestVersion,
          request.ingestedAt
        ),
      'SessionIngestDO.ingest.direct',
      { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 }
    );
  } catch (error) {
    return fallbackAfterDirectFailure(
      request,
      r2Key,
      buffered.bytes,
      contentLength,
      actualBytes,
      validation.validItemCount,
      startedAt,
      error
    );
  }

  if (ingestResult.accepted === false) {
    logEvent('info', {
      event: 'direct_ingest_tombstone',
      ...baseEvent,
      declaredBytes: contentLength,
      actualBytes,
      durationMs: elapsed(startedAt),
      items: validation.validItemCount,
    });
    return { status: 404, body: { success: false, error: 'session_not_found' } };
  }

  await runMetadataProjection(request, ingestResult.changes);
  logEvent('info', {
    event: 'direct_ingest_ok',
    ...baseEvent,
    declaredBytes: contentLength,
    actualBytes,
    durationMs: elapsed(startedAt),
    items: validation.validItemCount,
    metadataChanges: ingestResult.changes.length,
  });
  return { status: 200, body: { success: true } };
}

async function legacy(
  request: DirectIngestRequest,
  r2Key: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  reason: LegacyReason,
  declaredBytes: number | null,
  actualBytes: number | null,
  items: number | null,
  startedAt: number
): Promise<DirectIngestResponse> {
  try {
    await stageAndEnqueue(request.env, queueParams(request, r2Key), body);
  } catch (error) {
    logEvent('warn', {
      event: 'direct_ingest_legacy',
      ingestRequestId: request.ingestRequestId,
      sessionId: request.sessionId,
      ingestVersion: request.ingestVersion,
      reason,
      declaredBytes,
      actualBytes,
      durationMs: elapsed(startedAt),
      items,
      failureStage: error instanceof StageAndEnqueueError ? error.stage : 'staging_upload',
      error: errorMessage(error),
    });
    throw error;
  }
  logEvent('info', {
    event: 'direct_ingest_legacy',
    ingestRequestId: request.ingestRequestId,
    sessionId: request.sessionId,
    ingestVersion: request.ingestVersion,
    reason,
    declaredBytes,
    actualBytes,
    durationMs: elapsed(startedAt),
    items,
  });
  return { status: 200, body: { success: true } };
}

async function fallbackAfterDirectFailure(
  request: DirectIngestRequest,
  r2Key: string,
  bytes: Uint8Array,
  declaredBytes: number,
  actualBytes: number,
  items: number,
  startedAt: number,
  directError: unknown
): Promise<DirectIngestResponse> {
  try {
    await stageAndEnqueue(request.env, queueParams(request, r2Key), bytes);
  } catch (error) {
    logFallback(
      request,
      declaredBytes,
      actualBytes,
      items,
      startedAt,
      error,
      undefined,
      directError
    );
    throw error;
  }
  logFallback(request, declaredBytes, actualBytes, items, startedAt, directError, 'do_rpc');
  return { status: 200, body: { success: true } };
}

async function runMetadataProjection(
  request: DirectIngestRequest,
  changes: Array<{ name: string; value: string | null }>
): Promise<void> {
  if (changes.length === 0) return;
  const metadataPromise = applyMetadataChanges(
    request.env,
    request.kiloUserId,
    request.sessionId,
    new Map(changes.map(change => [change.name, change.value])),
    request.executionContext
  ).catch(error => {
    console.error({
      event: 'direct_ingest_metadata_error',
      ingestRequestId: request.ingestRequestId,
      sessionId: request.sessionId,
      error: errorMessage(error),
    });
  });

  if (request.executionContext) {
    request.executionContext.waitUntil(metadataPromise);
  } else {
    await metadataPromise;
  }
}

function parseContentLength(value: string | undefined): number | 'missing' | 'invalid' {
  if (value === undefined) return 'missing';
  if (!contentLengthPattern.test(value)) return 'invalid';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'invalid';
}

function queueParams(request: DirectIngestRequest, r2Key: string) {
  return {
    r2Key,
    kiloUserId: request.kiloUserId,
    sessionId: request.sessionId,
    ingestVersion: request.ingestVersion,
    ingestedAt: request.ingestedAt,
  };
}

function logFallback(
  request: DirectIngestRequest,
  declaredBytes: number | null,
  actualBytes: number | null,
  items: number | null,
  startedAt: number,
  error: unknown,
  stage?: 'do_rpc',
  directError?: unknown
) {
  const failureStage: 'do_rpc' | StageAndEnqueueFailureStage =
    stage ?? (error instanceof StageAndEnqueueError ? error.stage : 'staging_upload');
  logEvent('warn', {
    event: 'direct_ingest_fallback',
    ingestRequestId: request.ingestRequestId,
    sessionId: request.sessionId,
    ingestVersion: request.ingestVersion,
    declaredBytes,
    actualBytes,
    durationMs: elapsed(startedAt),
    items,
    stage: failureStage,
    error: errorMessage(error),
    ...(directError === undefined ? {} : { directError: errorMessage(directError) }),
  });
}

function logEvent(level: 'info' | 'warn', event: CommonEvent & Record<string, unknown>) {
  console[level](event);
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
