import * as z from 'zod';

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
