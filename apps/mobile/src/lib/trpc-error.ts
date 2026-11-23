import { z } from 'zod';

import {
  ACCOUNT_BLOCKED_REFUSAL_REASONS,
  accountBlockedRefusalReason,
  type AccountBlockedRefusalReason,
} from '@kilocode/app-shared/auth';
import { CONTROL_PLANE_TIMEOUT_MESSAGE } from '@kilocode/app-shared/control-plane';
import { isUsageSourceNotConfigured } from '@kilocode/app-shared/usage-source';

import { isRequestDeadlineError } from '@/lib/telemetry/abort-classification';

// Shared tRPC error helpers. tRPC v11 client errors expose `data.code` /
// `data.message` / `data.upstreamCode`; server-shaped errors expose the same
// under `shape.data`. Anything else is treated as an unknown transient error.

const DirectErrorSchema = z.looseObject({
  data: z.looseObject({
    code: z.string().optional(),
    message: z.string().optional(),
    upstreamCode: z.string().optional(),
    zodError: z.unknown().optional(),
  }),
});
const ShapedErrorSchema = z.looseObject({
  shape: z.looseObject({
    data: z.looseObject({
      code: z.string().optional(),
      message: z.string().optional(),
      upstreamCode: z.string().optional(),
      zodError: z.unknown().optional(),
    }),
  }),
});
const TopLevelCodeSchema = z.looseObject({ code: z.string() });
const NamedErrorSchema = z.looseObject({ name: z.string() });

/**
 * True when the error is a tRPC client error: one named `TRPCClientError`, or
 * one carrying a `data` / `shape.data` envelope. A bare top-level `code` is not
 * enough — filesystem, transport and domain errors carry one too — so a caller
 * that acts on a server verdict must not read it from an unrelated error.
 */
export function isTrpcClientError(error: unknown): boolean {
  const named = NamedErrorSchema.safeParse(error);
  return (
    (named.success && named.data.name === 'TRPCClientError') ||
    DirectErrorSchema.safeParse(error).success ||
    ShapedErrorSchema.safeParse(error).success
  );
}

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

/**
 * The tRPC codes whose envelope carries a sentence the application wrote for a
 * person. Everything else the wire can name is a framework or transport code —
 * `PARSE_ERROR`, `METHOD_NOT_SUPPORTED`, `NOT_IMPLEMENTED`,
 * `CLIENT_CLOSED_REQUEST`, `PAYLOAD_TOO_LARGE`, `TIMEOUT`,
 * `UNPROCESSABLE_CONTENT`, `INTERNAL_SERVER_ERROR`, and any code added upstream
 * — whose text nobody authored for a person. The check is an allowlist so a new
 * framework code reaches the screen as the caller's neutral line, not as
 * engineering text.
 */
const AUTHORED_REFUSAL_CODES = [
  'BAD_REQUEST',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TOO_MANY_REQUESTS',
] as const;

type AuthoredRefusalCode = (typeof AUTHORED_REFUSAL_CODES)[number];

/**
 * Whether this envelope carries a refusal the application wrote, so its
 * sentence may be shown to a person.
 *
 * - An authored refusal, such as a duplicate name (`CONFLICT`), carries a
 *   sentence written for the person, so the caller shows it.
 * - `INTERNAL_SERVER_ERROR`, and every other code outside the allowlist,
 *   carries diagnostic text, so the caller states its own neutral line.
 * - `UNAUTHORIZED` is outside the allowlist. The one context-level auth
 *   failure is already handled by the sign-out path, and every
 *   procedure-level one carries an org-access diagnostic, so the caller
 *   states its own line for both.
 * - A non-null `zodError` names an input contract failure, which has no
 *   reading for the person, so the caller states the neutral line too.
 *
 * An envelope without a code is not a server answer, so it yields no sentence.
 */
function isAuthoredRefusal(code: string | undefined, zodError: unknown): boolean {
  if (code === undefined || !AUTHORED_REFUSAL_CODES.includes(code as AuthoredRefusalCode)) {
    return false;
  }
  if (zodError !== undefined && zodError !== null) {
    return false;
  }
  return true;
}

/**
 * The sentence a tRPC SERVER answered with, or undefined when this error is not
 * a refusal the application wrote for a person.
 *
 * The envelope's code decides, not the presence of text: the server's formatted
 * `data` carries the code, status, path and zod error, so the sentence lives on
 * `Error.message` (`shape.data.message` when shaped). A 5xx or a validation
 * payload yields no sentence, and the caller states its neutral line.
 *
 * A transport wrapper is named `TRPCClientError` too and carries no `data`, so
 * it yields no sentence either.
 */
export function readTrpcServerMessage(error: unknown): string | undefined {
  const direct = DirectErrorSchema.safeParse(error);
  if (direct.success) {
    const { code, zodError } = direct.data.data;
    if (!isAuthoredRefusal(code, zodError)) {
      return undefined;
    }
    return error instanceof Error ? error.message : undefined;
  }
  const shaped = ShapedErrorSchema.safeParse(error);
  if (shaped.success) {
    const { code, message, zodError } = shaped.data.shape.data;
    return isAuthoredRefusal(code, zodError) ? message : undefined;
  }
  return undefined;
}

const TERMINAL_TRPC_CODES = [
  'BAD_REQUEST',
  'CONFLICT',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'UNPROCESSABLE_CONTENT',
] as const;

/**
 * True only for tRPC codes the user cannot recover from by retrying.
 *
 * Each terminal code names a state the same request cannot change: a payload
 * the input contract refuses, a record that is gone, a role or account session
 * the caller has lost, an input the server will not accept, or a conflict with
 * a state that already exists, such as a duplicate name. The action that
 * produced the failure stays on screen, so the surface keeps its explanation
 * and offers no Retry, and the copy beside the form is what the person acts on.
 *
 * `PRECONDITION_FAILED` stays retryable: the person can satisfy the
 * precondition, then send the same request again. `TOO_MANY_REQUESTS` stays
 * retryable too, because waiting resolves it.
 */
export function isTerminalTrpcCode(code: string | undefined): boolean {
  return TERMINAL_TRPC_CODES.includes(code as (typeof TERMINAL_TRPC_CODES)[number]);
}

/**
 * The terminal codes that reach {@link trpcErrorVariant}'s `terminal` state:
 * every terminal code except the three that carry a more precise state of
 * their own. `FORBIDDEN` and `UNAUTHORIZED` are access outcomes and reach
 * `permission`; `NOT_FOUND` names a removed item and reaches `not-found`.
 *
 * The type is derived from `TERMINAL_TRPC_CODES`, and the map is checked
 * against it, so a code added to the terminal list cannot be left out here:
 * the new code makes this object's `satisfies` fail until it is given a state,
 * and a key that is not a terminal code is an excess property.
 */
type NonAccessTerminalTrpcCode = Exclude<
  (typeof TERMINAL_TRPC_CODES)[number],
  'FORBIDDEN' | 'UNAUTHORIZED' | 'NOT_FOUND'
>;

const NON_ACCESS_TERMINAL_TRPC_CODES = {
  BAD_REQUEST: true,
  CONFLICT: true,
  UNPROCESSABLE_CONTENT: true,
} as const satisfies Record<NonAccessTerminalTrpcCode, true>;

/**
 * True only for the terminal codes that name a state of their own rather than
 * an access outcome or a removed item: `BAD_REQUEST`, `CONFLICT` and
 * `UNPROCESSABLE_CONTENT`. These are exactly the codes
 * {@link trpcErrorVariant} maps to `terminal`, and the shared source for that
 * set, so no reader has to restate the list.
 */
export function isNonAccessTerminalTrpcCode(code: string | undefined): boolean {
  return code !== undefined && Object.hasOwn(NON_ACCESS_TERMINAL_TRPC_CODES, code);
}

/**
 * True when the error's tRPC message names the unconfigured usage source
 * (`USAGE_SOURCE_NOT_CONFIGURED_MESSAGE`). The wire carries only the code and
 * message, so the string is the one signal a client has; the constant is
 * matched by identity with the one the server imported.
 *
 * The condition is terminal: with no usage source configured, no future read
 * can succeed, so a screen that acts on it must show its no-retry state.
 */
export function isUsageSourceUnavailable(error: unknown): boolean {
  return isUsageSourceNotConfigured(readTrpcErrorField(error, 'message'));
}

/** Whether asking the server again can plausibly succeed for this failure. */
export function isRetryableTrpcError(error: unknown): boolean {
  return !isTerminalTrpcCode(readTrpcErrorField(error, 'code'));
}

/** The user-facing state a tRPC call's failure maps to, shared by the screens. */
export type TrpcErrorVariant = 'permission' | 'not-found' | 'server' | 'terminal' | 'timeout';

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
 * Maps a call failure to the state the screen must show.
 *
 * A request that ran out its deadline is a retryable slow-response state: the
 * server may answer the next one, so it must not be reported as a server fault.
 *
 * The two access outcomes keep their own state: `FORBIDDEN` and `UNAUTHORIZED`
 * reach `permission`, since the reader may be able to regain access elsewhere,
 * and `NOT_FOUND` reaches `not-found`, because the item itself is gone.
 *
 * Every other terminal code reaches `terminal`: a `BAD_REQUEST`, a `CONFLICT`
 * or an `UNPROCESSABLE_CONTENT` names a state the same request cannot change —
 * a payload the input contract refuses, a record that already exists under that
 * name, an input the server will not accept. Retrying sends the identical
 * request and gets the identical refusal, so the surface must explain what it
 * is and offer no Retry (`isTerminalTrpcCode` decides the same set, and
 * `isNonAccessTerminalTrpcCode` names this subset of it).
 *
 * Everything else stays `server`: an `INTERNAL_SERVER_ERROR`, an unknown code
 * and a failure with no code at all may succeed on the next attempt.
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
  if (isNonAccessTerminalTrpcCode(code)) {
    return 'terminal';
  }
  return 'server';
}

type TrpcErrorData = {
  code?: string;
  authRequired?: boolean;
  accountBlocked?: boolean;
  accountBlockedReason?: AccountBlockedRefusalReason;
};

const TrpcErrorDataSchema = z.looseObject({
  code: z.string().optional(),
  authRequired: z.boolean().optional(),
  accountBlocked: z.boolean().optional(),
  // The shared reader drops a value this build does not know, so one unknown
  // field cannot fail the whole parse and hide a refusal's other fields from
  // `isAccountBlockedTrpcError` / `isPermissionDeniedError`.
  accountBlockedReason: z.preprocess(
    (value: unknown) => accountBlockedRefusalReason(value) ?? undefined,
    z.enum(ACCOUNT_BLOCKED_REFUSAL_REASONS).optional()
  ),
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

/**
 * True when the server refused the call because this account is blocked. A
 * blocked account's context-level refusal is a `FORBIDDEN` that is not a
 * permission loss: it stays a refusal while the person is signed in, so the
 * surface that explains it must be told apart from both an ordinary permission
 * denial and the unauthorized handler's sign-out (which keeps
 * `authRequired`). The formatter publishes `accountBlocked: true` and keeps
 * `authRequired` unset; the wire carries no `cause`, so this flag is the one
 * client-readable signal.
 */
export function isAccountBlockedTrpcError(error: unknown): boolean {
  return readTrpcErrorData(error)?.accountBlocked === true;
}

/**
 * Which of the two blocked-account refusals the server answered with, or null
 * when this error is not one of them (or carries no recognisable reason).
 *
 * The two reasons need different actions, which is why presence alone
 * (`isAccountBlockedTrpcError`) is not enough:
 *
 * - `'account_blocked'` is a property of one account, and support can lift it,
 *   so re-reading the account over the refused session can succeed.
 * - `'email_domain_blocked'` is a property of the account's email domain, so no
 *   retry, sign-out or sign-in changes the answer.
 *
 * The value travels as `data.accountBlockedReason` (or
 * `shape.data.accountBlockedReason`), and is validated through the shared
 * reader so an unknown string reaching an older client reads as no reason at
 * all rather than as a refused type.
 */
export function readAccountBlockedReason(error: unknown): AccountBlockedRefusalReason | null {
  return accountBlockedRefusalReason(readTrpcErrorData(error)?.accountBlockedReason);
}
