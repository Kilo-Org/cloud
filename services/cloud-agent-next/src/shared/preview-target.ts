import { z } from 'zod';

export const previewTargetSchema = z.union([
  z.object({
    worktreeId: z.templateLiteral(['worktree_', z.uuid()]),
    cloudAgentSessionId: z.never().optional(),
  }),
  z.object({
    cloudAgentSessionId: z.templateLiteral(['workspace_', z.uuid()]),
    worktreeId: z.never().optional(),
  }),
]);

export type PreviewTarget = z.infer<typeof previewTargetSchema>;
