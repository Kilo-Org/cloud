import type { ModelReply, ModelRequest, ModelUsage } from '../model.js';

/**
 * One gateway shape. A wire maps a request onto a body and maps the reply back.
 * `toReply` throws when the reply does not match; the caller wraps it.
 *
 * A stream event is an edge, so `toDelta` and `toUsage` validate what they read.
 * One event carries text, or token counts, or neither.
 */
interface Wire {
  readonly path: string;
  readonly toBody: (request: ModelRequest) => unknown;
  readonly toReply: (raw: unknown) => ModelReply;
  readonly toDelta: (event: unknown) => string | undefined;
  readonly toUsage: (event: unknown) => Partial<ModelUsage> | undefined;
}

export type { Wire };
