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

/**
 * The staged body outgrew the measured staging budget: the counting reader
 * stopped it before any storage write. The caller answers with the shared
 * too-large response instead of retrying or staging.
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

/**
 * Caps a request stream at `maxBytes` without buffering it: a counting pass-through
 * that rejects (`StagingOverflowError`) as soon as the running total exceeds the
 * limit, so memory stays flat no matter how large the body claims to be. The
 * consumer of the returned stream observes the rejection when the DO uploads the
 * body to storage; nothing is written on overflow. `onOverflow` runs locally when
 * the limit trips — the RPC layer reconstructs stream errors, so the flag is the
 * reliable signal that the body, not staging, was too large.
 */
export function boundedRequestBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void
): ReadableStream<Uint8Array> {
  let totalBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reader) reader = body.getReader();
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        totalBytes += result.value.byteLength;
        if (totalBytes > maxBytes) {
          onOverflow();
          controller.error(new StagingOverflowError());
          await cancelReader(body);
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void cancelReader(body);
    },
  });
}

async function cancelReader(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await stream.cancel('ingest body exceeded the staging limit');
  } catch {
    // The overflow error surfaced through the stream remains authoritative.
  }
}

export async function stageAndEnqueue(
  env: Env,
  params: StageAndEnqueueParams,
  body: ReadableStream<Uint8Array> | Uint8Array,
  declaredBytes?: number,
  overflowed?: () => boolean
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
    // The counting stream surfaces its overflow directly: it is the request's
    // own measure, not a staging failure, so the caller answers with the shared
    // too-large response instead of a staging error.
    if (error instanceof StagingOverflowError) throw error;
    throw new StageAndEnqueueError('staging_upload', error);
  }
  // The storage boundary may swallow a stream error and report success for a
  // body that was never fully written. A tripped overflow flag means no queue
  // message may reference the key.
  if (overflowed?.()) {
    await env.SESSION_INGEST_R2.delete(params.r2Key).catch(() => {});
    throw new StagingOverflowError();
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
