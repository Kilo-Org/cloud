import { Context, Data, type Effect, type Stream } from 'effect';
import type { Prompt } from './prompt.js';

/**
 * How hard the model should think. Both model SDKs spell the levels this way.
 *
 * This is not `maxTokens`. `maxTokens` is a wall the server enforces and the
 * model cannot see; effort is a dial the model itself follows. A reasoning
 * model spends its thinking out of `maxTokens`, so a low wall and a high effort
 * together produce no answer at all.
 */
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * What the model was asked. `model` and `effort` are part of the cache key.
 * `maxTokens` is not: it never reaches the rendered prefix, so it may vary from
 * one call to the next at no cost.
 */
interface ModelRequest {
  readonly prompt: Prompt;
  readonly model: string;
  readonly maxTokens: number;
  readonly effort?: Effort;
  readonly stream: boolean;
  /** Groups the requests of one session onto one cache entry. Use the session id. */
  readonly cacheKey?: string;
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

/**
 * Why the model stopped talking.
 *
 * `end` is a finished answer. `maxTokens` is a wall: the answer stops
 * mid-sentence, and a caller that treats it as finished stores half a thought
 * and builds every later request on it. `refusal` is the model declining.
 * `unknown` is a shape that reported nothing, which is not an error.
 */
type StopReason = 'end' | 'maxTokens' | 'refusal' | 'unknown';

interface ModelReply {
  readonly content: string;
  readonly usage: ModelUsage;
  readonly stop: StopReason;
}

/** A model call failed. `status` is the HTTP status when the transport has one. */
class ModelError extends Data.TaggedError('harness/ModelError')<{
  readonly reason: 'transport' | 'status' | 'body' | 'unsupported';
  readonly status?: number;
  readonly cause: unknown;
}> {}

/**
 * One piece of a streamed reply. The last event of a stream is always `done`.
 *
 * `reasoning` is the model thinking aloud. It is a separate kind because it is
 * not the answer: a caller shows it apart from the answer, or not at all.
 *
 * The signature arrives on its own `reasoning` event, after the thinking and
 * with no text, because that is how the provider streams it. A shape that
 * issues no signature sends none, and that thinking cannot be replayed.
 */
type ModelEvent =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string; readonly signature?: string }
  /** Thinking the provider encrypted. There is nothing here to show a reader. */
  | { readonly kind: 'redacted'; readonly data: string }
  | { readonly kind: 'done'; readonly usage: ModelUsage; readonly stop: StopReason };

const zeroUsage: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Sends an assembled prompt and returns the reply. Transport only: a plugin
 * must not build or change the prompt, because a changed prefix drops the cache.
 */
interface ModelClientService {
  readonly send: (request: ModelRequest) => Effect.Effect<ModelReply, ModelError>;
  readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ModelError>;
}

class ModelClient extends Context.Tag('harness/ModelClient')<ModelClient, ModelClientService>() {}

export type {
  Effort,
  ModelClientService,
  ModelEvent,
  ModelReply,
  ModelRequest,
  ModelUsage,
  StopReason,
};
export { ModelClient, ModelError, zeroUsage };
