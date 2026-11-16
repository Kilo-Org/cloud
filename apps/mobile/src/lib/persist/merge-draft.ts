import * as z from 'zod';
import { type PrMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';

// Tied to the merge-method union at compile time, so the persisted enum can
// never name a method the sheet cannot submit.
const MERGE_DRAFT_METHODS = [
  'merge',
  'squash',
  'rebase',
] as const satisfies readonly PrMergeMethod[];

const mergeDraftSchema = z.object({
  title: z.string(),
  message: z.string(),
  // Optional: every record written before the picker was persisted loads as a
  // draft without a method and falls back to the resolved default.
  method: z.enum(MERGE_DRAFT_METHODS).optional(),
});

/** Shape of one merge-sheet draft ({ title, message, method? }). */
export type MergeDraft = z.infer<typeof mergeDraftSchema>;

/** Runtime shape guard for a merge-sheet draft ({ title, message, method? }). */
export function isMergeDraft(value: unknown): value is MergeDraft {
  return mergeDraftSchema.safeParse(value).success;
}
