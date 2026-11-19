import { type BannerState } from '@/lib/offline-banner-state';
import { isTrpcClientError, readTrpcErrorField } from '@/lib/trpc-error';
import { z } from 'zod';

/** The presentation of a failed first load: who the failure blames. */
export type ReadFailureVariant = 'offline' | 'server';

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
 * A first load the online manager paused on a connection the app has CONFIRMED
 * is down: nothing was sent, so the read is still pending with no data and
 * reaches neither the loading gate nor the error branch, and only a Retry can
 * retire it.
 *
 * Confirmation is part of the test, not decoration. The manager also pauses on
 * an `unknown` NetInfo report (`installQueryClientNativeLifecycle`), which is
 * the normal cold-launch window before the reachability probe settles: a pause
 * there is not yet a connection failure, and naming one would flash a false
 * error on every cold deep link. The screens that already classify a cold
 * pause agree — `blocked-people-screen` and `list-body-state` both require
 * confirmed-offline connectivity and keep the skeleton while it is unsettled.
 */
export function isReadPausedBeforeData(read: {
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  connectivity: BannerState;
}): boolean {
  return read.isPending && read.fetchStatus === 'paused' && read.connectivity === 'offline';
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
