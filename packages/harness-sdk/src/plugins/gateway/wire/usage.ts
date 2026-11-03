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
 * are called. A reply that reports more cached tokens than input tokens is
 * inconsistent, but the counts still leave here non-negative: the non-cached
 * remainder is floored at zero, and the cached count is kept as reported.
 */
const readCached = (input: number, output: number, cached: number): Partial<ModelUsage> => ({
  inputTokens: Math.max(0, input - cached),
  outputTokens: output,
  cacheReadTokens: cached,
});

/**
 * The cost fields the Kilo gateway and OpenRouter add to a usage frame. They
 * are read apart from the check, so a provider that sends them in another form
 * loses the cost and keeps its token counts.
 */
interface CostFields {
  cost?: unknown;
  is_byok?: unknown;
  cost_details?: unknown;
}

const upstreamOf = (details: unknown): unknown =>
  typeof details === 'object' && details !== null && 'upstream_inference_cost' in details
    ? details.upstream_inference_cost
    : undefined;

/**
 * What the call cost in US dollars. A call OpenRouter served on a provider key
 * (`is_byok`) reports only OpenRouter's fee in `cost`; the inference itself is
 * `cost_details.upstream_inference_cost`, which is what the gateway bills.
 */
const costOf = (usage: CostFields): { readonly cost?: number } => {
  const cost = usage.is_byok === true ? upstreamOf(usage.cost_details) : usage.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { cost } : {};
};

export type { CostFields, Counts, TokenCount };
export { costOf, readCached, set };
