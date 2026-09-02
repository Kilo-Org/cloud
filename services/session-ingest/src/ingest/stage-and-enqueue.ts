import type { Env } from '../env';
import { withDORetry } from '@kilocode/worker-utils';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import type { IngestQueueMessage } from '../queue-consumer';

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

export async function stageAndEnqueue(
  env: Env,
  params: StageAndEnqueueParams,
  body: ReadableStream<Uint8Array> | Uint8Array
): Promise<boolean> {
  try {
    const stream = body instanceof Uint8Array ? new Blob([body]).stream() : body;
    const accepted = await withDORetry(
      () => getSessionIngestDO(env, params),
      stub =>
        stub.stageR2Object(
          { kiloUserId: params.kiloUserId, sessionId: params.sessionId, key: params.r2Key },
          stream
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
