import { Context, Data, type Effect } from 'effect';
import type { Prompt } from './prompt.js';

/** What the model was asked. `model` is part of the cache key, so it belongs here. */
interface ModelRequest {
  readonly prompt: Prompt;
  readonly model: string;
  readonly maxTokens: number;
}

/**
 * Token counts for one reply. `cacheReadTokens / (cacheReadTokens + inputTokens)`
 * is the cache hit ratio, which must stay above 95 percent.
 */
interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface ModelReply {
  readonly content: string;
  readonly usage: ModelUsage;
}

/** A model call failed. `status` is the HTTP status when the transport has one. */
class ModelError extends Data.TaggedError('harness/ModelError')<{
  readonly reason: 'transport' | 'status' | 'body';
  readonly status?: number;
  readonly cause: unknown;
}> {}

/**
 * Sends an assembled prompt and returns the reply. Transport only: a plugin
 * must not build or change the prompt, because a changed prefix drops the cache.
 */
interface ModelClientService {
  readonly send: (request: ModelRequest) => Effect.Effect<ModelReply, ModelError>;
}

class ModelClient extends Context.Tag('harness/ModelClient')<ModelClient, ModelClientService>() {}

export type { ModelClientService, ModelReply, ModelRequest, ModelUsage };
export { ModelClient, ModelError };
