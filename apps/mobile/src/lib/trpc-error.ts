// Shared tRPC error helpers. tRPC v11 client errors expose `data.code` /
// `data.message`; server-shaped errors expose `shape.data.code` /
// `shape.data.message`. Anything else is treated as an unknown transient
// error.

/**
 * Extracts a field from an unknown tRPC error. Reads `data[field]` first,
 * then `shape.data[field]`, then (for `code`) the top-level `code`, then
 * (for `message`) `Error.message`. Returns `undefined` when no string value
 * exists.
 */
export function readTrpcErrorField(error: unknown, field: 'code' | 'message'): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object') {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === 'string') {
      return value;
    }
  }
  const shape = record.shape;
  if (shape && typeof shape === 'object') {
    const shapeData = (shape as Record<string, unknown>).data;
    if (shapeData && typeof shapeData === 'object') {
      const value = (shapeData as Record<string, unknown>)[field];
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  if (field === 'code') {
    const top = record.code;
    if (typeof top === 'string') {
      return top;
    }
  }
  if (field === 'message' && error instanceof Error) {
    return error.message;
  }
  return undefined;
}

const TERMINAL_TRPC_CODES = [
  'BAD_REQUEST',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'UNPROCESSABLE_CONTENT',
] as const;

/** True only for tRPC codes the user cannot recover from by retrying. */
export function isTerminalTrpcCode(code: string | undefined): boolean {
  return TERMINAL_TRPC_CODES.includes(code as (typeof TERMINAL_TRPC_CODES)[number]);
}
