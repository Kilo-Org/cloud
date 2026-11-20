import { type BannerState } from '@/lib/offline-banner-state';
import {
  isControlPlaneTimeout,
  isPermissionDeniedError,
  isTerminalTrpcCode,
  isTrpcClientError,
  readTrpcErrorField,
} from '@/lib/trpc-error';
import { z } from 'zod';

/** The presentation of a failed first load: who the failure blames. */
export type ReadFailureVariant = 'offline' | 'server';

/**
 * Which of the app's failure kinds a read landed in. A surface that reads
 * through more than one call (a card over a balance and an identity, a list
 * over its repositories and its rows) names ONE kind for the whole surface, so
 * the reader cannot be told two different things about one failure.
 *
 * Only `retryable`, `offline` and `timeout` can succeed on a second attempt: a
 * refusal is refused again, a missing item is the answer, and a terminal
 * contract failure needs different input rather than another request.
 */
export type ReadFailureKind =
  | 'offline'
  | 'timeout'
  | 'permission'
  | 'not-found'
  | 'terminal'
  | 'retryable';

/** True when asking the server again can plausibly succeed. */
export function readFailureKindIsRetryable(kind: ReadFailureKind): boolean {
  return kind === 'retryable' || kind === 'offline' || kind === 'timeout';
}

/** The `QueryError` variant that carries each kind's copy. */
const VARIANT_BY_KIND = {
  offline: 'offline',
  timeout: 'timeout',
  permission: 'permission',
  'not-found': 'not-found',
  // A terminal code the app has no better sentence for keeps the server's
  // copy: the read was answered, so neither the connection nor a missing item
  // describes it.
  terminal: 'server',
  retryable: 'server',
} as const satisfies Record<
  ReadFailureKind,
  'offline' | 'timeout' | 'permission' | 'not-found' | 'server'
>;

/**
 * The `QueryError` variant that carries the kind's copy: the connection's own
 * wording, a deadline's own wording, the refusal, the removed item, or the
 * server's failure. Plain strings so this module stays free of components.
 */
export function readFailureKindVariant(
  kind: ReadFailureKind
): 'offline' | 'timeout' | 'permission' | 'not-found' | 'server' {
  return VARIANT_BY_KIND[kind];
}

export type SelectReadFailureVariantInput = {
  /** Errors of the reads whose failure produced the error view. */
  errors: readonly unknown[];
  /** A read paused by the online manager; only an offline online-manager pauses. */
  isPaused: boolean;
  /** Committed connectivity — the state the offline banner paints. */
  connectivity: BannerState;
};

/**
 * Pure selector naming the cause of a failed first load.
 *
 * - a paused read, or confirmed-offline connectivity, is the connection;
 * - a failed read that carries a tRPC code, or a plain HTTP answer, reached the
 *   server, so the system wording stays;
 * - any other failed read never reached the server at all — a transport
 *   rejection carries neither — which is the connection too.
 */
export function classifyReadFailureVariant({
  errors,
  isPaused,
  connectivity,
}: SelectReadFailureVariantInput): ReadFailureVariant {
  const serverAnswered = errors.some(error => servedAnswer(error));
  const isConnection =
    isPaused || connectivity === 'offline' || (errors.length > 0 && !serverAnswered);
  return isConnection ? 'offline' : 'server';
}

/**
 * A first load the online manager paused while the app has settled whether it
 * is offline: nothing was sent, so the read is still pending with no data and
 * reaches neither the loading gate nor the error branch, and only a Retry can
 * retire it.
 *
 * `unknown` is excluded on purpose. The manager also pauses on an `unknown`
 * NetInfo report, which is the normal cold-launch window before the
 * reachability probe settles; a pause there is not a connection failure yet,
 * and naming one flashes a false error on every cold deep link. Main's shared
 * classifier settles the same way — `classifyConfigBody` and
 * `classifyListBody` both gate their paused-error state on a known connection
 * and keep loading while it is unsettled.
 */
export function isReadPausedBeforeData(read: {
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  connectivity: BannerState;
}): boolean {
  return read.isPending && read.fetchStatus === 'paused' && read.connectivity !== 'unknown';
}

/**
 * Names the kind of a failed first load, for the surfaces that must pick copy
 * and an action from it.
 *
 * A client-side deadline comes first: the app's own control-plane deadline
 * rejects with an error that carries no tRPC code and no HTTP status, so the
 * "no server answer" rule would call a slow-but-reachable server unreachable.
 * Its own copy names the wait, and a retry is the fix.
 *
 * Then the connection, but only when no read reached the server: a coded
 * answer proves the server was reachable, so a refusal beside a transport
 * error is still a refusal. After that, a refusal outranks a terminal code (a
 * `FORBIDDEN` is itself terminal, and the refusal copy is the one that
 * explains it); `NOT_FOUND` is the one terminal code that has its own copy,
 * and every other terminal code keeps the server's.
 */
export function classifyReadFailureKind({
  errors,
  isPaused,
  connectivity,
}: SelectReadFailureVariantInput): ReadFailureKind {
  if (errors.some(error => isControlPlaneTimeout(error))) {
    return 'timeout';
  }
  if (classifyReadFailureVariant({ errors, isPaused, connectivity }) === 'offline') {
    return 'offline';
  }
  if (errors.some(error => isPermissionDeniedError(error))) {
    return 'permission';
  }
  if (errors.some(error => readTrpcErrorField(error, 'code') === 'NOT_FOUND')) {
    return 'not-found';
  }
  if (errors.some(error => isTerminalTrpcCode(readTrpcErrorField(error, 'code')))) {
    return 'terminal';
  }
  return 'retryable';
}

function servedAnswer(error: unknown): boolean {
  // A bare top-level `code` is not a server answer on its own: transport and
  // abort errors carry one too (the Expo fetch cancellation names itself in
  // `code`). Only a real tRPC error envelope, or a status the answer carried,
  // proves the server answered.
  if (isTrpcClientError(error) && readTrpcErrorField(error, 'code') !== undefined) {
    return true;
  }
  return readHttpStatus(error) !== undefined;
}

// A wrapper that mirrors fetch stores the answer's status on the error itself;
// tRPC-style envelopes hold it beside the code in `data` / `shape.data`.
const StatusOnData = z.looseObject({ status: z.number().optional() });
const StatusInData = z.looseObject({ data: StatusOnData });
const StatusShaped = z.looseObject({ shape: StatusInData });

/** The response's HTTP status for a plain non-tRPC fetch answer. */
function readHttpStatus(error: unknown): number | undefined {
  const shaped = StatusShaped.safeParse(error);
  if (shaped.success && shaped.data.shape.data.status !== undefined) {
    return shaped.data.shape.data.status;
  }
  const direct = StatusInData.safeParse(error);
  if (direct.success && direct.data.data.status !== undefined) {
    return direct.data.data.status;
  }
  const top = StatusOnData.safeParse(error);
  return top.success ? top.data.status : undefined;
}
