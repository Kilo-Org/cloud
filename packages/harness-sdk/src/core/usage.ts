import type { ModelUsage } from './model.js';

const add = (held: ModelUsage, part: ModelUsage): ModelUsage => ({
  inputTokens: held.inputTokens + part.inputTokens,
  outputTokens: held.outputTokens + part.outputTokens,
  cacheReadTokens: held.cacheReadTokens + part.cacheReadTokens,
  cacheWriteTokens: held.cacheWriteTokens + part.cacheWriteTokens,
});

/**
 * Folds one frame's counts into what this reply has reported so far.
 *
 * Every shape reports the counts of the whole reply in each frame, not the
 * counts of that frame. So a count only ever rises, and a later zero says
 * nothing rather than correcting an earlier number. Overwriting instead of
 * raising loses the input counts to any provider that echoes zeros in its
 * last frame, which reads as a cache hit ratio of exactly zero.
 */
const raise = (held: ModelUsage, part: Partial<ModelUsage>): ModelUsage => ({
  inputTokens: Math.max(held.inputTokens, part.inputTokens ?? 0),
  outputTokens: Math.max(held.outputTokens, part.outputTokens ?? 0),
  cacheReadTokens: Math.max(held.cacheReadTokens, part.cacheReadTokens ?? 0),
  cacheWriteTokens: Math.max(held.cacheWriteTokens, part.cacheWriteTokens ?? 0),
});

/**
 * The share of the input that came from the cache. This must stay above 0.95.
 * Returns zero when nothing has been read yet.
 */
const hitRatio = (usage: ModelUsage): number => {
  const total = usage.cacheReadTokens + usage.inputTokens;
  return total === 0 ? 0 : usage.cacheReadTokens / total;
};

export { add, hitRatio, raise };
