import { Layer, Stream } from 'effect';
import {
  ModelClient,
  type ModelError,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
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
  /** Why the model stopped. A scripted answer finished unless it says so. */
  readonly stop?: StopReason;
  /** Thinking the provider encrypted, streamed whole, ahead of the deltas. */
  readonly redacted?: readonly string[];
  /** Never reaches `done`, so a test can interrupt the stream part way. */
  readonly stall?: boolean;
  /**
   * The events to stream, in this order, instead of the fields above. It is
   * how a test scripts an order the fields cannot express, such as thinking
   * that is interrupted by a block the provider encrypted.
   */
  readonly events?: readonly ModelEvent[];
}

/**
 * A model that answers from a script and records what it was asked. It is how
 * this package tests a session without a network and without spending credit.
 *
 * It is not exported: `dist/` carries no test double. A consumer who wants one
 * writes two functions against `ModelClientService`, which is the whole of the
 * plugin point. Ship this instead the day somebody asks for it.
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
      reply.events ?? [
        ...(reply.redacted ?? []).map((data): ModelEvent => ({ kind: 'redacted', data })),
        ...(reply.reasoning ?? []).map((text): ModelEvent => ({ kind: 'reasoning', text })),
        ...(reply.signature === undefined
          ? []
          : [{ kind: 'reasoning', text: '', signature: reply.signature } as ModelEvent]),
        ...reply.deltas.map((text): ModelEvent => ({ kind: 'delta', text })),
      ]
    );
    const done = Stream.succeed<ModelEvent>({
      kind: 'done',
      usage: { ...zeroUsage, ...reply.usage },
      stop: reply.stop ?? 'end',
    });
    if (reply.stall === true) {
      return Stream.concat(deltas, Stream.never);
    }
    return reply.fail === undefined
      ? Stream.concat(deltas, done)
      : Stream.concat(deltas, Stream.fail(reply.fail));
  };

  return { calls, layer: Layer.succeed(ModelClient, { stream }) };
};

export type { FakeReply };
export { fakeModel };
