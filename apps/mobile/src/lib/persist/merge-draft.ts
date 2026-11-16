import * as z from 'zod';

// Every field is optional: the sheet persists only what the user authored, so a
// method-only tap stores `{ method }` and a text-only edit stores no method.
//
// The method is an open string rather than a union because the restore narrows
// it against the pull request's allowed methods. A record written by another
// build keeps its user-authored text loadable here instead of failing the shape
// check — a mismatch is deliberately left stored for the build that can read it
// (see `drafts.ts`), so rejecting the whole record would hide its text for the
// life of the install.
const mergeDraftSchema = z.object({
  title: z.string().optional(),
  message: z.string().optional(),
  method: z.string().optional(),
});

/** Shape of one merge-sheet draft ({ title?, message?, method? }). */
export type MergeDraft = z.infer<typeof mergeDraftSchema>;

/** Runtime shape guard for a merge-sheet draft ({ title?, message?, method? }). */
export function isMergeDraft(value: unknown): value is MergeDraft {
  return mergeDraftSchema.safeParse(value).success;
}
