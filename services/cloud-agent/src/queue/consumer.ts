/**
 * Queue consumer for processing execution messages.
 *
 * Handles incoming messages from Cloudflare Queues, managing
 * retries, error handling, and starting the wrapper process
 * for actual execution processing.
 *
 * This file has the sandbox import - use consumer-core.ts for tests.
 */

import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { ExecutionMessage } from './types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { Env } from '../types.js';
import { createQueueConsumerWithDeps } from './consumer-core.js';

// Re-export createQueueConsumerWithDeps from consumer-core for tests
export { createQueueConsumerWithDeps, type ConsumerDeps } from './consumer-core.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Environment bindings required by the queue consumer.
 */
export type QueueConsumerEnv = Env & {
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Worker base URL for building WebSocket ingest endpoint */
  WORKER_URL?: string;
};

/**
 * Create the queue consumer handler function with default sandbox dependencies.
 *
 * The consumer processes execution messages from Cloudflare Queues.
 * For each message, it:
 * 1. Prepares the workspace (if initialization execution)
 * 2. Writes the prompt to a temp file
 * 3. Starts the wrapper process
 * 4. Acks and exits - wrapper handles the rest
 *
 * @returns Queue handler function compatible with Cloudflare Workers
 *
 * @example
 * ```ts
 * export default {
 *   queue: createQueueConsumer(),
 * };
 * ```
 */
export function createQueueConsumer() {
  return async function queue(
    batch: MessageBatch<ExecutionMessage>,
    env: QueueConsumerEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    const consumer = createQueueConsumerWithDeps({
      getSandbox: async (sandboxId: string) =>
        getSandbox(env.Sandbox, sandboxId, { sleepAfter: 900 }),
      getSessionStub: (userId, sessionId) => getSessionStub(env, userId, sessionId),
    });

    await consumer(batch, env, ctx);
  };
}

/**
 * Get a session DO stub.
 */
function getSessionStub(
  env: QueueConsumerEnv,
  userId: string,
  sessionId: string
): DurableObjectStub<CloudAgentSession> {
  const doKey = `${userId}:${sessionId}`;
  const id = env.CLOUD_AGENT_SESSION.idFromName(doKey);
  return env.CLOUD_AGENT_SESSION.get(id);
}
