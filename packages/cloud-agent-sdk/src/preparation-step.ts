import * as z from 'zod';
import { PREPARATION_OUTPUT_TAIL_MAX_BYTES } from './limits';

export const PREPARATION_MAX_DETAIL_LENGTH = 16_384;

/**
 * A snapshot's retained tail carries the same byte budget the client applies
 * when it trims step output. The character maximum is a cheap first pass: a
 * string can never encode to fewer bytes than it has characters, so anything
 * rejected there would fail the byte check too.
 */
const preparationOutputTailSchema = z
  .string()
  .max(PREPARATION_OUTPUT_TAIL_MAX_BYTES)
  .refine(
    value => new TextEncoder().encode(value).byteLength <= PREPARATION_OUTPUT_TAIL_MAX_BYTES,
    { message: `Output tail cannot exceed ${PREPARATION_OUTPUT_TAIL_MAX_BYTES} UTF-8 bytes` }
  );

export const preparationStepSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(['phase', 'setup_command']),
  label: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.number(),
  startedRevision: z.number().optional(),
  parentStepId: z.string().optional(),
  completedAt: z.number().optional(),
  revision: z.number(),
  latestDetail: z.string().max(PREPARATION_MAX_DETAIL_LENGTH).optional(),
  snapshotCapturedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
  safeError: z.string().optional(),
  command: z.string().optional(),
  commandIndex: z.number().optional(),
  commandCount: z.number().optional(),
  outputTail: preparationOutputTailSchema.optional(),
  outputTruncated: z.boolean().optional(),
  exitCode: z.number().optional(),
});
