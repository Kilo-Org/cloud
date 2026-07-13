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
  | 'empty_body'
  | 'oversized_body'
  | 'oversized_item'
  | 'multi_chunk';

type DirectNoopReason = 'missing_data' | 'wrong_type_data' | 'empty_data' | 'no_valid_items';

type DirectIngestMetrics = {
  declaredBytes: number | null;
  actualBytes: number | null;
  items: number | null;
};

type LegacyOptions = {
  reason: LegacyReason;
  metrics: DirectIngestMetrics;
  startedAt: number;
};

type DirectIngestResult = IngestResult | { accepted?: undefined; changes: IngestResult['changes'] };

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
  const r2Key = `ingest/${request.kiloUserId}/${request.sessionId}/${request.ingestRequestId}`;
  const configResult = parseDirectIngestConfig(request.env);

  if (!configResult.ok) {
    console.error({ event: 'direct_ingest_config_error', reason: configResult.reason });
    return legacy(request, r2Key, request.body, {
      reason: 'gate_config',
      metrics: unknownMetrics(),
      startedAt,
    });
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
    return legacy(request, r2Key, request.body, {
      reason: 'gate_config',
      metrics: unknownMetrics(),
      startedAt,
    });
  }
  if (!selection.selected) {
    return legacy(request, r2Key, request.body, {
      reason: 'gate_percent',
      metrics: unknownMetrics(),
      startedAt,
    });
  }

  const contentLength = parseContentLength(request.contentLength);
  if (contentLength === 'missing') {
    return legacy(request, r2Key, request.body, {
      reason: 'no_content_length',
      metrics: unknownMetrics(),
      startedAt,
    });
  }
  if (contentLength === 'invalid') {
    return legacy(request, r2Key, request.body, {
      reason: 'invalid_content_length',
      metrics: unknownMetrics(),
      startedAt,
    });
  }
  if (contentLength === 'empty') {
    return legacy(request, r2Key, request.body, {
      reason: 'empty_body',
      metrics: { declaredBytes: 0, actualBytes: null, items: null },
      startedAt,
    });
  }
  if (contentLength > configResult.config.maxBytes) {
    return legacy(request, r2Key, request.body, {
      reason: 'oversized_body',
      metrics: { declaredBytes: contentLength, actualBytes: null, items: null },
      startedAt,
    });
  }

  let buffered: Awaited<ReturnType<typeof readBoundedStream>>;
  try {
    buffered = await readBoundedStream(request.body, contentLength);
  } catch (error) {
    logEvent('warn', {
      event: 'direct_ingest_error',
      ...eventBase(request, startedAt, {
        declaredBytes: contentLength,
        actualBytes: null,
        items: null,
      }),
      stage: 'body_read',
      error: errorMessage(error),
    });
    throw error;
  }
  if (!buffered.ok) {
    logEvent('warn', {
      event: 'direct_ingest_reject',
      ...eventBase(request, startedAt, {
        declaredBytes: contentLength,
        actualBytes: null,
        items: null,
      }),
      reason: 'declared_bytes_exceeded',
    });
    return { status: 413, body: { success: false, error: 'payload_too_large' } };
  }

  const actualBytes = buffered.bytes.byteLength;
  const validation = validateAndParseIngestPayload(buffered.bytes);
  if (!validation.ok) {
    logEvent('warn', {
      event: 'direct_ingest_parse_reject',
      ...eventBase(request, startedAt, { declaredBytes: contentLength, actualBytes, items: null }),
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
      event: 'direct_ingest_noop',
      ...eventBase(request, startedAt, { declaredBytes: contentLength, actualBytes, items: 0 }),
      reason: directNoopReason(validation),
    });
    return { status: 200, body: { success: true } };
  }

  if (validation.maxValidItemBytes > MAX_INGEST_ITEM_BYTES) {
    return legacy(request, r2Key, buffered.bytes, {
      reason: 'oversized_item',
      metrics: { declaredBytes: contentLength, actualBytes, items: validation.validItemCount },
      startedAt,
    });
  }
  if (
    validation.validItemCount > INGEST_CHUNK_MAX_ITEMS ||
    // The byte check is defensive while the HTTP body cap equals the RPC byte budget,
    // but keeps direct eligibility tied to the shared chunk policy if either limit moves.
    validation.totalValidItemBytes > INGEST_CHUNK_MAX_BYTES
  ) {
    return legacy(request, r2Key, buffered.bytes, {
      reason: 'multi_chunk',
      metrics: { declaredBytes: contentLength, actualBytes, items: validation.validItemCount },
      startedAt,
    });
  }

  let ingestResult: DirectIngestResult;
  try {
    ingestResult = await withDORetry<ReturnType<typeof getSessionIngestDO>, DirectIngestResult>(
      () =>
        getSessionIngestDO(request.env, {
          kiloUserId: request.kiloUserId,
          sessionId: request.sessionId,
        }),
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
      { declaredBytes: contentLength, actualBytes, items: validation.validItemCount },
      startedAt,
      error
    );
  }

  // `accepted === false` is intentionally exact for gradual deploy compatibility:
  // older DO code returns `{ changes }` without an accepted flag and must remain success.
  if (ingestResult.accepted === false) {
    logEvent('info', {
      event: 'direct_ingest_tombstone',
      ...eventBase(request, startedAt, {
        declaredBytes: contentLength,
        actualBytes,
        items: validation.validItemCount,
      }),
    });
    return { status: 404, body: { success: false, error: 'session_not_found' } };
  }

  await runMetadataProjection(request, ingestResult.changes);
  logEvent('info', {
    event: 'direct_ingest_ok',
    ...eventBase(request, startedAt, {
      declaredBytes: contentLength,
      actualBytes,
      items: validation.validItemCount,
    }),
    metadataChanges: ingestResult.changes.length,
  });
  return { status: 200, body: { success: true } };
}

async function legacy(
  request: DirectIngestRequest,
  r2Key: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: LegacyOptions
): Promise<DirectIngestResponse> {
  try {
    await stageAndEnqueue(request.env, legacyQueueParams(request, r2Key), body);
  } catch (error) {
    logEvent('warn', {
      event: 'direct_ingest_legacy',
      ...eventBase(request, options.startedAt, options.metrics),
      reason: options.reason,
      failureStage: error instanceof StageAndEnqueueError ? error.stage : 'staging_upload',
      error: errorMessage(error),
    });
    throw error;
  }
  logEvent('info', {
    event: 'direct_ingest_legacy',
    ...eventBase(request, options.startedAt, options.metrics),
    reason: options.reason,
  });
  return { status: 200, body: { success: true } };
}

async function fallbackAfterDirectFailure(
  request: DirectIngestRequest,
  r2Key: string,
  bytes: Uint8Array,
  metrics: DirectIngestMetrics,
  startedAt: number,
  directError: unknown
): Promise<DirectIngestResponse> {
  try {
    await stageAndEnqueue(request.env, directFallbackQueueParams(request, r2Key), bytes);
  } catch (error) {
    logFallback(request, metrics, startedAt, error, undefined, directError);
    throw error;
  }
  logFallback(request, metrics, startedAt, directError, 'do_rpc');
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

function parseContentLength(value: string | undefined): number | 'missing' | 'invalid' | 'empty' {
  if (value === undefined) return 'missing';
  if (!contentLengthPattern.test(value)) return 'invalid';
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return 'invalid';
  return parsed === 0 ? 'empty' : parsed;
}

function legacyQueueParams(request: DirectIngestRequest, r2Key: string) {
  return {
    r2Key,
    kiloUserId: request.kiloUserId,
    sessionId: request.sessionId,
    ingestVersion: request.ingestVersion,
  };
}

function directFallbackQueueParams(request: DirectIngestRequest, r2Key: string) {
  return {
    ...legacyQueueParams(request, r2Key),
    ingestedAt: request.ingestedAt,
  };
}

function logFallback(
  request: DirectIngestRequest,
  metrics: DirectIngestMetrics,
  startedAt: number,
  error: unknown,
  stage?: 'do_rpc',
  directError?: unknown
) {
  const failureStage: 'do_rpc' | StageAndEnqueueFailureStage =
    stage ?? (error instanceof StageAndEnqueueError ? error.stage : 'staging_upload');
  logEvent('warn', {
    event: 'direct_ingest_fallback',
    ...eventBase(request, startedAt, metrics),
    stage: failureStage,
    error: errorMessage(error),
    ...(directError === undefined ? {} : { directError: errorMessage(directError) }),
  });
}

function unknownMetrics(): DirectIngestMetrics {
  return { declaredBytes: null, actualBytes: null, items: null };
}

function directNoopReason(validation: {
  dataArray: 'present' | 'missing' | 'wrong_type';
  skippedItemCount: number;
}): DirectNoopReason {
  if (validation.dataArray === 'missing') return 'missing_data';
  if (validation.dataArray === 'wrong_type') return 'wrong_type_data';
  return validation.skippedItemCount > 0 ? 'no_valid_items' : 'empty_data';
}

function eventBase(
  request: DirectIngestRequest,
  startedAt: number,
  metrics: DirectIngestMetrics
): CommonEvent {
  return {
    ingestRequestId: request.ingestRequestId,
    sessionId: request.sessionId,
    ingestVersion: request.ingestVersion,
    declaredBytes: metrics.declaredBytes,
    actualBytes: metrics.actualBytes,
    durationMs: elapsed(startedAt),
    items: metrics.items,
  };
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
