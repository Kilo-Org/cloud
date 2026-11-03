import type { Env } from '../env';
import { withDORetry } from '@kilocode/worker-utils';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import type { IngestQueueMessage } from '../queue-consumer';
import type { SessionIngestDO } from '../dos/SessionIngestDO';
import { INGEST_CHUNK_MAX_BYTES } from '../util/ingest-limits';
import { readBoundedStream } from './bounded-stream-reader';

type StageAndEnqueueParams = Omit<IngestQueueMessage, 'r2Key' | 'ingestedAt'> & {
  r2Key: string;
  ingestedAt?: number;
};

export type StageAndEnqueueFailureStage = 'staging_upload' | 'queue_send';

type StagingStub = Pick<SessionIngestDO, 'stageR2Object' | 'stageBoundedR2Object'>;

/**
 * The staged body exceeded its byte budget. The Durable Object aborts its
 * multipart upload and returns this result before any object is published.
 */
export class StagingOverflowError extends Error {
  constructor() {
    super('Ingest body exceeds the staging byte budget');
    this.name = 'StagingOverflowError';
  }
}

export class StageAndEnqueueError extends Error {
  constructor(
    readonly stage: StageAndEnqueueFailureStage,
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StageAndEnqueueError';
  }
}

/**
 * Chooses how a staging body crosses the DO RPC boundary. A `ReadableStream`
 * argument cannot be transferred to the DO under `wrangler dev` — it fails with
 * "ReadableStream received over RPC disconnected prematurely" — while an
 * `ArrayBufferView` is passed by value and R2 accepts it directly. A by-value body
 * counts against the RPC payload limit, so only a body whose length is known and
 * within `INGEST_CHUNK_MAX_BYTES` is read into bytes; a larger or unmeasured body
 * keeps streaming (which works in production).
 */
export async function toRpcBody(
  body: ReadableStream<Uint8Array> | Uint8Array,
  declaredBytes: number | undefined
): Promise<Uint8Array | ReadableStream<Uint8Array>> {
  if (body instanceof Uint8Array) {
    return body.byteLength <= INGEST_CHUNK_MAX_BYTES ? body : new Blob([body]).stream();
  }
  if (declaredBytes === undefined || declaredBytes > INGEST_CHUNK_MAX_BYTES) return body;
  const result = await readBoundedStream(body, INGEST_CHUNK_MAX_BYTES);
  if (!result.ok) throw new StagingOverflowError();
  return result.bytes;
}

export async function stageAndEnqueue(
  env: Env,
  params: StageAndEnqueueParams,
  body: ReadableStream<Uint8Array> | Uint8Array,
  declaredBytes?: number,
  maxBytes?: number
): Promise<boolean> {
  try {
    const rpcBody = await toRpcBody(body, declaredBytes);
    const result = await withDORetry<StagingStub, boolean | 'too_large'>(
      () => getSessionIngestDO(env, params),
      stub =>
        maxBytes === undefined
          ? stub.stageR2Object(
              { kiloUserId: params.kiloUserId, sessionId: params.sessionId, key: params.r2Key },
              rpcBody
            )
          : stub.stageBoundedR2Object(
              { kiloUserId: params.kiloUserId, sessionId: params.sessionId, key: params.r2Key },
              rpcBody,
              maxBytes
            ),
      maxBytes === undefined
        ? 'SessionIngestDO.stageR2Object'
        : 'SessionIngestDO.stageBoundedR2Object',
      { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 }
    );
    if (result === 'too_large') throw new StagingOverflowError();
    if (!result) return false;
  } catch (error) {
    if (error instanceof StagingOverflowError) throw error;
    throw new StageAndEnqueueError('staging_upload', error);
  }

  const message: IngestQueueMessage = {
    ...params,
    ingestedAt: params.ingestedAt ?? Date.now(),
  };

  try {
    await env.INGEST_QUEUE.send(message);
  } catch (error) {
    await env.SESSION_INGEST_R2.delete(params.r2Key).catch(() => {});
    throw new StageAndEnqueueError('queue_send', error);
  }
  return true;
}
