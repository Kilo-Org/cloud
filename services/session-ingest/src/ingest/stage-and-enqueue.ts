import type { Env } from '../env';
import { withDORetry } from '@kilocode/worker-utils';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import type { IngestQueueMessage } from '../queue-consumer';
import { INGEST_CHUNK_MAX_BYTES } from '../util/ingest-limits';
import { readBoundedStream } from './bounded-stream-reader';

type StageAndEnqueueParams = Omit<IngestQueueMessage, 'r2Key' | 'ingestedAt'> & {
  r2Key: string;
  ingestedAt?: number;
};

export type StageAndEnqueueFailureStage = 'staging_upload' | 'queue_send';

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
  if (!result.ok) throw new Error('Ingest body exceeds the staging byte budget');
  return result.bytes;
}

export async function stageAndEnqueue(
  env: Env,
  params: StageAndEnqueueParams,
  body: ReadableStream<Uint8Array> | Uint8Array,
  declaredBytes?: number
): Promise<boolean> {
  try {
    const rpcBody = await toRpcBody(body, declaredBytes);
    const accepted = await withDORetry(
      () => getSessionIngestDO(env, params),
      stub =>
        stub.stageR2Object(
          { kiloUserId: params.kiloUserId, sessionId: params.sessionId, key: params.r2Key },
          rpcBody
        ),
      'SessionIngestDO.stageR2Object',
      { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 }
    );
    if (!accepted) return false;
  } catch (error) {
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
