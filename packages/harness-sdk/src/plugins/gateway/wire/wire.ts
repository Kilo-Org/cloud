import { createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage, StopReason } from '../../../core/model.js';

/**
 * What one streamed event says, when it says anything.
 *
 * A signature arrives on its own event, after the thinking and with no text,
 * because that is how a provider streams it.
 *
 * `redacted` is thinking the provider encrypted rather than showed. It has no
 * text at all, and it is a kind of its own so that nothing can render its bytes
 * as words by mistake.
 *
 * Every member is a `ModelEvent` as it stands, so a part reaches the caller
 * unchanged and no conversion sits on the per-token path. A member added here
 * that `ModelEvent` does not hold fails the gateway's own return type.
 */
type WirePart =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string; readonly signature?: string }
  | { readonly kind: 'redacted'; readonly data: string };

/**
 * One gateway shape. A wire maps a request onto a body and maps the reply back.
 * `toReply` and `toBody` throw when a shape cannot carry what it was given; the
 * caller wraps them.
 *
 * A stream event is an edge, so every reader below validates what it finds.
 * One event carries text, or reasoning, or token counts, or a stop reason, or
 * nothing at all.
 */
interface Wire {
  readonly path: string;
  readonly toBody: (request: ModelRequest) => unknown;
  readonly toReply: (raw: unknown) => ModelReply;
  readonly toDelta: (event: unknown) => WirePart | undefined;
  readonly toUsage: (event: unknown) => Partial<ModelUsage> | undefined;
  /** Absent until the event that says why the model stopped. */
  readonly toStop: (event: unknown) => StopReason | undefined;
}

/**
 * Reads a stop reason a shape reports by name. A name the table does not hold
 * is `unknown` rather than nothing: the model did stop, and this package
 * simply has no word for why. No name at all is nothing, because that frame
 * was not the one that said.
 */
const stopFrom =
  (reasons: Readonly<Record<string, StopReason>>) =>
  (named: string | null | undefined): StopReason | undefined =>
    named === null || named === undefined ? undefined : (reasons[named] ?? 'unknown');

/**
 * A failure the provider reported after the answer started.
 *
 * All three shapes mark one the same way, with an `error` object on the frame,
 * so it is read once here rather than per shape. Anthropic's streaming
 * reference says so outright: the API may send an error in the event stream,
 * such as an `overloaded_error` that would have been a 529 had the call not
 * been streamed. Letting the frame pass ends the stream on `done` and stores a
 * fragment as a whole answer.
 *
 * Only a top-level `error` object counts. A shape that reports `error: null`
 * on a frame that succeeded, as the responses shape does inside `response`,
 * does not match.
 */
interface FailureEvent {
  error: { message?: string; type?: string };
}

const isFailure = createIs<FailureEvent>();

export type { Wire, WirePart };
export { isFailure, stopFrom };
