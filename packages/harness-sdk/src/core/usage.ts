import type { ModelUsage } from './model.js';

const add = (held: ModelUsage, part: ModelUsage): ModelUsage => ({
  inputTokens: held.inputTokens + part.inputTokens,
  outputTokens: held.outputTokens + part.outputTokens,
  cacheReadTokens: held.cacheReadTokens + part.cacheReadTokens,
  cacheWriteTokens: held.cacheWriteTokens + part.cacheWriteTokens,
});

/**
 * The share of the input that came from the cache. This must stay above 0.95.
 * Returns zero when nothing has been read yet.
 */
const hitRatio = (usage: ModelUsage): number => {
  const total = usage.cacheReadTokens + usage.inputTokens;
  return total === 0 ? 0 : usage.cacheReadTokens / total;
};

export { add, hitRatio };
