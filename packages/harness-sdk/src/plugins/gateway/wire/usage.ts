import type { tags } from 'typia';
import type { ModelUsage } from '../../../core/model.js';

/**
 * A token count as a provider reports it. `uint32` is what makes the check
 * reject `NaN` and `Infinity`: `JSON.parse` turns an overflowing literal into
 * `Infinity`, and a bare `number` accepts it, which then poisons every later
 * sum with `NaN`.
 */
type TokenCount = number & tags.Type<'uint32'>;

type Counts = { -readonly [K in keyof ModelUsage]?: number };

/** Writes a count only when the reply carried one. A missing count is not a zero. */
const set = (target: Counts, key: keyof ModelUsage, value: number | null | undefined): void => {
  const count = value ?? undefined;
  if (count !== undefined) {
    target[key] = count;
  }
};

/**
 * Both OpenAI shapes report the cached tokens inside the input total, so the
 * cached count is subtracted out. They differ only in what the three fields
 * are called.
 */
const readCached = (input: number, output: number, cached: number): Partial<ModelUsage> => ({
  inputTokens: input - cached,
  outputTokens: output,
  cacheReadTokens: cached,
});

/**
 * A whole count for a reply that was not streamed. A missing count is a zero
 * here, unlike in a stream, because there is no later frame to raise it.
 *
 * Neither OpenAI shape reports what a cache write cost, so that stays zero.
 */
const whole = (counts: Partial<ModelUsage>): ModelUsage => ({
  inputTokens: counts.inputTokens ?? 0,
  outputTokens: counts.outputTokens ?? 0,
  cacheReadTokens: counts.cacheReadTokens ?? 0,
  cacheWriteTokens: counts.cacheWriteTokens ?? 0,
});

export type { Counts, TokenCount };
export { readCached, set, whole };
