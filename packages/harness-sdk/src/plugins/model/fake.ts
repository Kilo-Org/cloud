import { Effect, Layer, Stream } from 'effect';
import {
  ModelClient,
  type ModelError,
  type ModelEvent,
  type ModelReply,
  type ModelRequest,
  type ModelUsage,
  zeroUsage,
} from '../../core/model.js';

/** One scripted answer. `fail` ends the stream after the deltas it lists. */
interface FakeReply {
  readonly deltas: readonly string[];
  readonly usage?: Partial<ModelUsage>;
  readonly fail?: ModelError;
}

/**
 * A model that answers from a script and records what it was asked. It lets a
 * consumer test its own code without a network and without spending credit.
 */
const fakeModel = (
  replies: readonly FakeReply[]
): { readonly calls: ModelRequest[]; readonly layer: Layer.Layer<ModelClient> } => {
  const calls: ModelRequest[] = [];
  const nextReply = (request: ModelRequest): FakeReply => {
    calls.push(request);
    return replies[Math.min(calls.length - 1, replies.length - 1)] ?? { deltas: [] };
  };

  const stream = (request: ModelRequest): Stream.Stream<ModelEvent, ModelError> => {
    const reply = nextReply(request);
    const deltas = Stream.fromIterable(
      reply.deltas.map((text): ModelEvent => ({ kind: 'delta', text }))
    );
    const done = Stream.succeed<ModelEvent>({
      kind: 'done',
      usage: { ...zeroUsage, ...reply.usage },
    });
    return reply.fail === undefined
      ? Stream.concat(deltas, done)
      : Stream.concat(deltas, Stream.fail(reply.fail));
  };

  const send = (request: ModelRequest): Effect.Effect<ModelReply, ModelError> => {
    const reply = nextReply(request);
    return reply.fail === undefined
      ? Effect.succeed({
          content: reply.deltas.join(''),
          usage: { ...zeroUsage, ...reply.usage },
        })
      : Effect.fail(reply.fail);
  };

  return { calls, layer: Layer.succeed(ModelClient, { send, stream }) };
};

export type { FakeReply };
export { fakeModel };
