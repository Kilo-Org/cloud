import { z } from 'zod';
import type { ControlPlaneTimers } from '../../shared/control-plane-timers.js';

type RecoveryTimers = Pick<
  ControlPlaneTimers['session'],
  'transportRecoveryMs' | 'transportRecoveryWindowMs'
>;

/**
 * The one durable queued transport recovery obligation (spec "Queued transport
 * recovery"). `since` is when the current window of unanswered passes started;
 * it bounds the retries, so the window does not restart with every pass.
 */
export type TransportRecovery = { dueAt: number; since: number };

const timestampSchema = z.number().int().nonnegative();
const storedTransportRecoverySchema = z.union([
  z.object({ dueAt: timestampSchema, since: timestampSchema }).strict(),
  // A deploy before the window stored only the due time of its single pass.
  timestampSchema,
]);

export function parseTransportRecovery(
  raw: unknown,
  timers: RecoveryTimers
): TransportRecovery | null {
  const parsed = storedTransportRecoverySchema.safeParse(raw);
  if (!parsed.success) return null;
  if (typeof parsed.data !== 'number') return parsed.data;
  return { dueAt: parsed.data, since: parsed.data - timers.transportRecoveryMs };
}

/**
 * The pass after an unanswered pass, or `null` when the window is spent and
 * queued work must fail. The delay doubles from `transportRecoveryMs` and stops
 * at four times it (15 s, 30 s, then 60 s).
 */
export function nextTransportRecovery(
  since: number,
  now: number,
  timers: RecoveryTimers
): TransportRecovery | null {
  const unansweredMs = now - since;
  if (unansweredMs >= timers.transportRecoveryWindowMs) return null;
  return { since, dueAt: now + recoveryDelayMs(unansweredMs, timers.transportRecoveryMs) };
}

function recoveryDelayMs(unansweredMs: number, firstDelayMs: number): number {
  if (unansweredMs < firstDelayMs) return firstDelayMs;
  if (unansweredMs < 3 * firstDelayMs) return 2 * firstDelayMs;
  return 4 * firstDelayMs;
}
