import { z } from 'zod';

// Shared tRPC error helpers. tRPC v11 client errors expose `data.code` /
// `data.message`; server-shaped errors expose `shape.data.code` /
// `shape.data.message`. Anything else is treated as an unknown transient
// error.

const DirectErrorSchema = z.looseObject({
  data: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
});
const ShapedErrorSchema = z.looseObject({
  shape: z.looseObject({
    data: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
  }),
});
const TopLevelCodeSchema = z.looseObject({ code: z.string() });

/**
 * Extracts a field from an unknown tRPC error. Reads `data[field]` first,
 * then `shape.data[field]`, then (for `code`) the top-level `code`, then
 * (for `message`) `Error.message`. Returns `undefined` when no string value
 * exists.
 */
export function readTrpcErrorField(error: unknown, field: 'code' | 'message'): string | undefined {
  const direct = DirectErrorSchema.safeParse(error);
  if (direct.success && direct.data.data[field] !== undefined) {
    return direct.data.data[field];
  }
  const shaped = ShapedErrorSchema.safeParse(error);
  if (shaped.success && shaped.data.shape.data[field] !== undefined) {
    return shaped.data.shape.data[field];
  }
  if (field === 'code') {
    const top = TopLevelCodeSchema.safeParse(error);
    if (top.success) {
      return top.data.code;
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
