import { ReasoningEffortSchema, type ReasoningEffort } from '@kilocode/auto-routing-contracts';

export function parsePersistedReasoningEffort(value: string | null): ReasoningEffort | null {
  if (value === null) {
    return null;
  }

  const parsed = ReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** D1 stores '' for the null/default variant; application code uses null. */
export function variantToStorage(variant: string | null | undefined): string {
  return variant ?? '';
}

/** Convert a D1-stored variant ('' = null) back to the application null form. */
export function variantFromStorage(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return null;
  return stored;
}

/**
 * Platform runs still select one reasoningEffort per model. Map that effort
 * key to the canonical stored variant value (today's CLI --variant value).
 */
export function variantFromReasoningEffort(effort: string | null | undefined): string | null {
  return effort ?? null;
}
