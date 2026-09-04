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

/**
 * One scripted answer. `fail` ends the stream after the deltas it lists.
 *
 * `reasoning` streams before the deltas, which is the order a model produces
 * them in.
 */
interface FakeReply {
  readonly deltas: readonly string[];
  readonly reasoning?: readonly string[];
  readonly usage?: Partial<ModelUsage>;
  readonly fail?: ModelError;
  /** Closes the thinking, the way a provider does, on its own event. */
  readonly signature?: string;
  /** Never reaches `done`, so a test can interrupt the stream part way. */
  readonly stall?: boolean;
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
    const deltas = Stream.fromIterable([
      ...(reply.reasoning ?? []).map((text): ModelEvent => ({ kind: 'reasoning', text })),
      ...(reply.signature === undefined
        ? []
        : [{ kind: 'reasoning', text: '', signature: reply.signature } as ModelEvent]),
      ...reply.deltas.map((text): ModelEvent => ({ kind: 'delta', text })),
    ]);
    const done = Stream.succeed<ModelEvent>({
      kind: 'done',
      usage: { ...zeroUsage, ...reply.usage },
    });
    if (reply.stall === true) {
      return Stream.concat(deltas, Stream.never);
    }
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
