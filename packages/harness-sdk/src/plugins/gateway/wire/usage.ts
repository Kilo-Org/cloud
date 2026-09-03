import type { ModelUsage } from '../../../core/model.js';

type Counts = { -readonly [K in keyof ModelUsage]?: number };

/** Writes a count only when the reply carried one. A missing count is not a zero. */
const set = (target: Counts, key: keyof ModelUsage, value: number | null | undefined): void => {
  const count = value ?? undefined;
  if (count !== undefined) {
    target[key] = count;
  }
};

export type { Counts };
export { set };
