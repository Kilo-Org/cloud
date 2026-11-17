import { type BannerState } from '@/lib/offline-banner-state';
import { readTrpcErrorField } from '@/lib/trpc-error';
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

function servedAnswer(error: unknown): boolean {
  if (readTrpcErrorField(error, 'code') !== undefined) {
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
