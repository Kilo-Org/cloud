import type { ApiKind } from '../../core/catalog.js';

/**
 * Ranked by what each shape lets a caller control, best first. `messages` takes
 * an explicit cache breakpoint and takes its thinking back signed. `responses`
 * names a cache key and takes its thinking back encrypted. A completion
 * controls the cache not at all and can replay no thinking, because the
 * providers relayed through it report it under two names and take neither back.
 *
 * The cache half of that order is not what holds the hit ratio above 95
 * percent. Measured on 2026-09-04, this gateway places its own breakpoints and
 * every shape cached the same prefix identically with what this package sends
 * and without it. What holds the ratio is the prefix never moving. See
 * AGENTS.md, "The kilo gateway".
 */
const ranked: readonly ApiKind[] = ['messages', 'responses', 'chat_completions'];

/** Picks the best kind a model speaks. Returns undefined when it speaks none. */
const pickKind = (supported: readonly ApiKind[]): ApiKind | undefined =>
  ranked.find(kind => supported.includes(kind));

export { pickKind };
