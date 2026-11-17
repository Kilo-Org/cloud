import * as z from 'zod';

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

// The two fields that carry a model's reasoning identity. Their schema types
// differ (a canonical variant key is a string, the legacy effort is an enum
// value), so this rule reads only whether each one is set.
type VariantExclusiveFields = {
  readonly variant?: unknown;
  readonly reasoningEffort?: unknown;
};

/**
 * Reader precedence for model variant identity: prefer `variant`; when absent,
 * a valid legacy `reasoningEffort` string may be interpreted as the legacy
 * variant key. New writers emit `variant` only; old writers emitted
 * `reasoningEffort` only. Both non-null is malformed.
 *
 * Every schema that carries the two fields calls this function, so a change to
 * the condition, the issue path, or the issue code cannot leave one schema
 * behind. `subject` is the only per-schema part: it names the row in the
 * message.
 */
export function refineVariantExclusivity(
  value: VariantExclusiveFields,
  ctx: z.RefinementCtx,
  subject: string
): void {
  if (value.variant != null && value.reasoningEffort != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['variant'],
      message: `${subject} must not set both variant and reasoningEffort; emit variant only`,
    });
  }
}
