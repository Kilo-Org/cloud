import { z } from 'zod';

/**
 * A cleanup child must be a real Kilo session row. Shared by the worktree delete
 * path and the API-side child listing so the two cannot drift.
 */
export const sessionChildSchema = z.object({
  id: z.string().startsWith('ses_').length(30),
  directory: z.string(),
});

export type SessionChild = z.infer<typeof sessionChildSchema>;
