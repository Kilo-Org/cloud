import { type BannerState } from '@/lib/offline-banner-state';
import {
  isPermissionDeniedError,
  isTerminalTrpcCode,
  isTrpcClientError,
  readTrpcErrorField,
} from '@/lib/trpc-error';
import { z } from 'zod';

/** The presentation of a failed first load: who the failure blames. */
export type ReadFailureVariant = 'offline' | 'server';

/**
 * Which of the app's four failure kinds a read landed in. A surface that reads
 * through more than one call (a card over a balance and an identity, a list
 * over its repositories and its rows) names ONE kind for the whole surface, so
 * the reader cannot be told two different things about one failure.
 *
 * Only `retryable` and `offline` can succeed on a second attempt: a refusal is
 * refused again, and a terminal code is the answer.
 */
export type ReadFailureKind = 'offline' | 'permission' | 'terminal' | 'retryable';

/** True when asking the server again can plausibly succeed. */
export function readFailureKindIsRetryable(kind: ReadFailureKind): boolean {
  return kind === 'retryable' || kind === 'offline';
}

/**
 * The `QueryError` variant that carries the kind's copy: the connection's own
 * wording, the refusal, the removed-or-malformed read, or the server's
 * transient failure. Plain strings so this module stays free of components.
 */
export function readFailureKindVariant(
  kind: ReadFailureKind
): 'offline' | 'permission' | 'not-found' | 'server' {
  switch (kind) {
    case 'offline':
      return 'offline';
    case 'permission':
      return 'permission';
    case 'terminal':
      return 'not-found';
    case 'retryable':
      return 'server';
  }
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
 * The connection comes first, but only when no read reached the server: a
 * coded answer proves the server was reachable, so a refusal beside a
 * transport error is still a refusal. After that, a refusal outranks a
 * terminal code (a `FORBIDDEN` is itself terminal, and the refusal copy is the
 * one that explains it), then any other terminal code, then a transient
 * failure.
 */
export function classifyReadFailureKind({
  errors,
  isPaused,
  connectivity,
}: SelectReadFailureVariantInput): ReadFailureKind {
  if (classifyReadFailureVariant({ errors, isPaused, connectivity }) === 'offline') {
    return 'offline';
  }
  if (errors.some(error => isPermissionDeniedError(error))) {
    return 'permission';
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
