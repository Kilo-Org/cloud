import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';

/** What one streamed event says, when it says anything. */
interface WirePart {
  readonly kind: 'delta' | 'reasoning';
  readonly text: string;
}

/**
 * One gateway shape. A wire maps a request onto a body and maps the reply back.
 * `toReply` and `toBody` throw when a shape cannot carry what it was given; the
 * caller wraps them.
 *
 * A stream event is an edge, so `toDelta` and `toUsage` validate what they read.
 * One event carries text, or reasoning, or token counts, or nothing.
 */
interface Wire {
  readonly path: string;
  readonly toBody: (request: ModelRequest) => unknown;
  readonly toReply: (raw: unknown) => ModelReply;
  readonly toDelta: (event: unknown) => WirePart | undefined;
  readonly toUsage: (event: unknown) => Partial<ModelUsage> | undefined;
}

export type { Wire, WirePart };
