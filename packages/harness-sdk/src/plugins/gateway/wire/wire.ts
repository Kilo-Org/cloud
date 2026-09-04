import type { ModelReply, ModelRequest, ModelUsage, StopReason } from '../../../core/model.js';

/**
 * What one streamed event says, when it says anything.
 *
 * A signature arrives on its own event, after the thinking and with no text,
 * because that is how a provider streams it.
 */
interface WirePart {
  readonly kind: 'delta' | 'reasoning';
  readonly text: string;
  readonly signature?: string;
}

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

export type { Wire, WirePart };
