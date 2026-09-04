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

export type { Wire, WirePart };
export { stopFrom };
