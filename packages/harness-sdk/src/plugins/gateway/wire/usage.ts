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

export type { Counts, TokenCount };
export { set };
