import type { UsageEnqueueOutcome } from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';

export type PublicationOutcome =
  | UsageEnqueueOutcome
  | { kind: 'unavailable'; reason: 'unexpected_rejection'; errorName: string };

/**
 * The publisher reports every transport failure as an outcome, so a rejection is unexpected and may
 * follow a send; keep only the error's name, because its message can carry the ingress URL.
 */
export function unexpectedRejection(error: unknown): PublicationOutcome {
  return {
    kind: 'unavailable',
    reason: 'unexpected_rejection',
    errorName: error instanceof Error ? error.name : typeof error,
  };
}
