import { z } from 'zod';

// Safety limits
export const MAX_SQL_LENGTH = 100 * 1024; // 100KB
export const MAX_BATCH_SIZE = 100;

/**
 * Schema for query method
 */
const queryMethodSchema = z.enum(['get', 'all', 'run', 'values']);

/**
 * Schema for a single query request
 */
export const queryRequestSchema = z.object({
  sql: z.string().max(MAX_SQL_LENGTH, `SQL exceeds maximum length of ${MAX_SQL_LENGTH} bytes`),
  params: z.array(z.unknown()).default([]),
  method: queryMethodSchema,
});

type QueryRequest = z.infer<typeof queryRequestSchema>;

/**
 * Schema for batch request
 */
export const batchRequestSchema = z.object({
  queries: z
    .array(queryRequestSchema)
    .max(MAX_BATCH_SIZE, `Batch exceeds maximum size of ${MAX_BATCH_SIZE} queries`),
});

type BatchRequest = z.infer<typeof batchRequestSchema>;

export function parseQueryRequest(body: unknown):
  | {
      success: true;
      data: QueryRequest;
    }
  | {
      success: false;
      error: string;
    } {
  const result = queryRequestSchema.safeParse(body);
  if (!result.success) {
    return { success: false, error: result.error.issues[0]?.message || 'Invalid request' };
  }

  return { success: true, data: result.data };
}

export function parseBatchRequest(body: unknown):
  | {
      success: true;
      data: BatchRequest;
    }
  | {
      success: false;
      error: string;
    } {
  const result = batchRequestSchema.safeParse(body);
  if (!result.success) {
    return { success: false, error: result.error.issues[0]?.message || 'Invalid request' };
  }

  return { success: true, data: result.data };
}
