import { z } from 'zod';

import { CONTROL_PLANE_TIMEOUT_MESSAGE } from '@kilocode/app-shared/control-plane';

import { isRequestDeadlineError } from '@/lib/telemetry/abort-classification';

// Shared tRPC error helpers. tRPC v11 client errors expose `data.code` /
// `data.message` / `data.upstreamCode`; server-shaped errors expose the same
// under `shape.data`. Anything else is treated as an unknown transient error.

const DirectErrorSchema = z.looseObject({
  data: z.looseObject({
    code: z.string().optional(),
    message: z.string().optional(),
    upstreamCode: z.string().optional(),
  }),
});
const ShapedErrorSchema = z.looseObject({
  shape: z.looseObject({
    data: z.looseObject({
      code: z.string().optional(),
      message: z.string().optional(),
      upstreamCode: z.string().optional(),
    }),
  }),
});
const TopLevelCodeSchema = z.looseObject({ code: z.string() });

/**
 * Extracts a field from an unknown tRPC error. Reads `data[field]` first,
 * then `shape.data[field]`, then (for `code`) the top-level `code`, then
 * (for `message`) `Error.message`. Returns `undefined` when no string value
 * exists.
 */
export function readTrpcErrorField(
  error: unknown,
  field: 'code' | 'message' | 'upstreamCode'
): string | undefined {
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

/** Whether asking the server again can plausibly succeed for this failure. */
export function isRetryableTrpcError(error: unknown): boolean {
  return !isTerminalTrpcCode(readTrpcErrorField(error, 'code'));
}

/** The user-facing state a tRPC call's failure maps to, shared by the screens. */
export type TrpcErrorVariant = 'permission' | 'not-found' | 'server' | 'timeout';

/** The deepest `cause` chain walked when looking for the client deadline. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether the failure is a control-plane request that ran out of time, in
 * either place it can happen:
 *
 * - The server budgets every mobile control-plane call at 10 s and answers
 *   `INTERNAL_SERVER_ERROR` with {@link CONTROL_PLANE_TIMEOUT_MESSAGE} when the
 *   procedure outlives it. The wire carries only that message, so it is
 *   matched by identity with the constant both sides import.
 * - The app gives the same call `CONTROL_PLANE_DEADLINE_MS` (15 s) and then
 *   abandons it with a `RequestDeadlineError` (lib/trpc.ts). That abort has no
 *   tRPC code at all, and the tRPC link can carry it as the `cause` of the
 *   error the query observes.
 *
 * Neither is a server fault: the request was slow, and the next attempt can
 * succeed. Without this check both read as an unexplained server failure.
 */
export function isControlPlaneTimeout(error: unknown): boolean {
  if (readTrpcErrorField(error, 'message') === CONTROL_PLANE_TIMEOUT_MESSAGE) {
    return true;
  }
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (isRequestDeadlineError(current)) {
      return true;
    }
    if (current === null || current === undefined) {
      return false;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Maps a call failure to the state the screen must show. A request that ran
 * out its deadline is a retryable slow-response state: the server may answer
 * the next one, so it must not be reported as a server fault. A terminal code
 * that is not an access outcome (a bad request, an unprocessable payload)
 * stays a server state: it is a contract failure, not a permission one, and no
 * retry is offered for it either (`isTerminalTrpcCode`).
 */
export function trpcErrorVariant(error: unknown): TrpcErrorVariant {
  if (isControlPlaneTimeout(error)) {
    return 'timeout';
  }
  const code = readTrpcErrorField(error, 'code');
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    return 'permission';
  }
  if (code === 'NOT_FOUND') {
    return 'not-found';
  }
  return 'server';
}

type TrpcErrorData = {
  code?: string;
  authRequired?: boolean;
};

const TrpcErrorDataSchema = z.looseObject({
  code: z.string().optional(),
  authRequired: z.boolean().optional(),
});
const TrpcErrorEnvelopeSchema = z.looseObject({
  data: z.unknown().optional(),
  shape: z.looseObject({ data: z.unknown().optional() }).optional(),
});

/** The serialized tRPC error data, from either the direct or shaped variant. */
function readTrpcErrorData(error: unknown): TrpcErrorData | undefined {
  const parsedError = TrpcErrorEnvelopeSchema.safeParse(error);
  if (!parsedError.success) {
    return undefined;
  }
  const direct = TrpcErrorDataSchema.safeParse(parsedError.data.data);
  if (direct.success) {
    return direct.data;
  }
  const shaped = TrpcErrorDataSchema.safeParse(parsedError.data.shape?.data);
  return shaped.success ? shaped.data : undefined;
}

/**
 * True when the error is a permission loss: a `FORBIDDEN`, or a procedure-level
 * `UNAUTHORIZED` without the context-level `authRequired` flag (which the
 * unauthorized handler signs the user out on). Permission loss must drop the
 * affected cache, not the session.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  const data = readTrpcErrorData(error);
  if (data?.code === 'FORBIDDEN') {
    return true;
  }
  return data?.code === 'UNAUTHORIZED' && data.authRequired !== true;
}
