import { Effect, Ref } from 'effect';
import { type ModelUsage, zeroUsage } from './model.js';
import type { Wiring } from './wiring.js';

/**
 * The cost of two parts together. A part that reported none adds nothing, and
 * the sum stays absent only when neither reported one: a caller has to be able
 * to tell a session nobody priced from a session that cost nothing.
 */
const costOf = (held: number | undefined, part: number | undefined): { readonly cost?: number } =>
  held === undefined && part === undefined ? {} : { cost: (held ?? 0) + (part ?? 0) };

const add = (held: ModelUsage, part: ModelUsage): ModelUsage => ({
  inputTokens: held.inputTokens + part.inputTokens,
  outputTokens: held.outputTokens + part.outputTokens,
  cacheReadTokens: held.cacheReadTokens + part.cacheReadTokens,
  cacheWriteTokens: held.cacheWriteTokens + part.cacheWriteTokens,
  ...costOf(held.cost, part.cost),
});

const countUsage = (
  wiring: Wiring,
  call: { readonly usage: ModelUsage; readonly model?: string }
): Effect.Effect<void> =>
  Effect.andThen(
    Ref.update(wiring.totals, held => add(held, call.usage)),
    Ref.update(wiring.modelTotals, held => {
      const model = call.model ?? wiring.model;
      return new Map(held).set(model, add(held.get(model) ?? zeroUsage, call.usage));
    })
  );

/**
 * Folds one frame's counts into what this reply has reported so far.
 *
 * Every shape reports the counts of the whole reply in each frame, not the
 * counts of that frame. So a count only ever rises, and a later zero says
 * nothing rather than correcting an earlier number. Overwriting instead of
 * raising loses the input counts to any provider that echoes zeros in its
 * last frame, which reads as a cache hit ratio of exactly zero. The cost is
 * the reply's too, so it is raised the same way.
 */
const raise = (held: ModelUsage, part: Partial<ModelUsage>): ModelUsage => {
  const cost = part.cost === undefined ? held.cost : Math.max(held.cost ?? 0, part.cost);
  return {
    inputTokens: Math.max(held.inputTokens, part.inputTokens ?? 0),
    outputTokens: Math.max(held.outputTokens, part.outputTokens ?? 0),
    cacheReadTokens: Math.max(held.cacheReadTokens, part.cacheReadTokens ?? 0),
    cacheWriteTokens: Math.max(held.cacheWriteTokens, part.cacheWriteTokens ?? 0),
    ...(cost === undefined ? {} : { cost }),
  };
};

/**
 * The share of the input that came from the cache. Returns zero when nothing has
 * been read yet.
 *
 * There is no floor to hold this to, and one used to be written here. The
 * number is partly the provider's: the same prompt through the same code read
 * 0.79 on one run and 0.99 on the next, and the model run spans 0.28 to 0.9997
 * across providers. A live run asserts `cacheReadTokens > 0` instead — see
 * "Many models, a longer conversation" in AGENTS.md.
 */
const hitRatio = (usage: ModelUsage): number => {
  const total = usage.cacheReadTokens + usage.inputTokens;
  return total === 0 ? 0 : usage.cacheReadTokens / total;
};

export { add, countUsage, hitRatio, raise };
