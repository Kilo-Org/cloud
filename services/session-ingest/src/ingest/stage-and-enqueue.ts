import type { Env } from '../env';
import type { IngestQueueMessage } from '../queue-consumer';

type StageAndEnqueueParams = Omit<IngestQueueMessage, 'r2Key'> & { r2Key: string };

export async function stageAndEnqueue(
  env: Env,
  params: StageAndEnqueueParams,
  body: ReadableStream<Uint8Array> | Uint8Array
): Promise<void> {
  await env.SESSION_INGEST_R2.put(params.r2Key, body);

  try {
    await env.INGEST_QUEUE.send(params);
  } catch (error) {
    await env.SESSION_INGEST_R2.delete(params.r2Key).catch(() => {});
    throw error;
  }
}
