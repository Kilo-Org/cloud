import { z } from 'zod';

export const MAX_AUTO_COMMIT_MESSAGE_BYTES = 16 * 1024;
export const commitHashSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const autoCommitRecordSchema = z.object({
  commitHash: commitHashSchema,
  commitMessage: z
    .string()
    .max(MAX_AUTO_COMMIT_MESSAGE_BYTES)
    .refine(
      message => new TextEncoder().encode(message).byteLength <= MAX_AUTO_COMMIT_MESSAGE_BYTES,
      'Commit message exceeds the size limit'
    ),
  userMessageId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  committedAt: z.string().datetime({ offset: true }),
  pushStatus: z.enum(['pushed', 'failed', 'not_attempted', 'unknown']),
  commitMessageTruncated: z.literal(true).optional(),
});

export type AutoCommitRecord = z.infer<typeof autoCommitRecordSchema>;
