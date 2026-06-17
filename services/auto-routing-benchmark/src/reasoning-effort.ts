import { ReasoningEffortSchema, type ReasoningEffort } from '@kilocode/auto-routing-contracts';

export function parsePersistedReasoningEffort(value: string | null): ReasoningEffort | null {
  if (value === null) {
    return null;
  }

  const parsed = ReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
