import type { ApiKind } from '../../core/catalog.js';

/**
 * Ranked best first. `messages` wins because it takes explicit cache
 * breakpoints, which is how the cache hit ratio is held above 95 percent.
 * `responses` comes next: it caches on a key the caller gives. A completion
 * caches only what the upstream provider decides on its own.
 */
const ranked: readonly ApiKind[] = ['messages', 'responses', 'chat_completions'];

/** Picks the best kind a model speaks. Returns undefined when it speaks none. */
const pickKind = (supported: readonly ApiKind[]): ApiKind | undefined =>
  ranked.find(kind => supported.includes(kind));

export { pickKind };
