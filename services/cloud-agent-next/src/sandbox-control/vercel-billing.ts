/**
 * The Vercel billing producer. It owns the generation → provider-lifetime
 * binding and splits settlement into a synchronous, awaited "prepare" phase
 * (persist terminal evidence, mark the existing continuation due) and a later
 * "deliver" phase (pin the alive cursor, persist the stop, tick the heartbeat).
 *
 * It never calls `setAlarm`/`deleteAlarm` (that stays in `control-alarm.ts`) and never
 * calls `recordStop` directly; settlement delivery routes through
 * `billingHeartbeatTick`, which owns stop retry and the 60-minute abandon.
 */
import {
  BILLING_HEARTBEAT_CALLBACK,
  getBillingContext,
  type BillingContext,
  type BillingContextStorage,
  type BillingHeartbeatController,
} from '@kilocode/container-usage';
import { z } from 'zod';
import type { MeteredBillingLifecycle } from '../metered-billing-lifecycle.js';
import type { BillingScheduleTable } from './billing-schedule.js';

export const VERCEL_BILLING_BINDING_KEY_PREFIX = 'vercel-billing:binding:v1:';

/**
 * Continuation callback id; the payload is the generation id. It is the
 * installed heartbeat's callback, so one schedule entry per open generation is
 * shared by the measurement heartbeat and settlement. Cancellation must not drop
 * the durable continuation before settlement completes.
 */
export const VERCEL_BILLING_SETTLEMENT_CALLBACK = BILLING_HEARTBEAT_CALLBACK;

export const vercelBillingBindingSchema = z
  .object({
    generation: z.uuid(),
    providerRef: z.string().min(1).max(512),
    createdAtMs: z.number().int().nonnegative().finite(),
    terminalAtMs: z.number().int().nonnegative().finite().optional(),
  })
  .strict();

export type VercelBillingBinding = z.infer<typeof vercelBillingBindingSchema>;

export function vercelBillingBindingKey(generation: string): string {
  return `${VERCEL_BILLING_BINDING_KEY_PREFIX}${generation}`;
}

export async function loadVercelBillingBinding(
  storage: BillingContextStorage,
  generation: string
): Promise<VercelBillingBinding | undefined> {
  const stored = await storage.get(vercelBillingBindingKey(generation));
  if (stored === undefined) return undefined;
  return vercelBillingBindingSchema.parse(stored);
}

export async function saveVercelBillingBinding(
  storage: BillingContextStorage,
  binding: VercelBillingBinding
): Promise<void> {
  await storage.put(
    vercelBillingBindingKey(binding.generation),
    vercelBillingBindingSchema.parse(binding)
  );
}

export async function deleteVercelBillingBinding(
  storage: BillingContextStorage,
  generation: string
): Promise<void> {
  await storage.delete(vercelBillingBindingKey(generation));
}

export type VercelBillingDeps = {
  storage: BillingContextStorage;
  lifecycle: MeteredBillingLifecycle;
  heartbeat: BillingHeartbeatController;
  schedule: BillingScheduleTable;
};

export type VercelSettlementEvidence = {
  generation: string;
  createdAtMs?: number;
  terminalAtMs?: number;
};

export class VercelBilling {
  constructor(private readonly deps: VercelBillingDeps) {}

  /**
   * Persist terminal evidence and mark the existing continuation settlement-due.
   * It must already be armed by the pre-create path; this never inserts one.
   * Does not take the billing or heartbeat queue and does not call the pin,
   * `persistStop`, or the heartbeat tick. A compose error propagates.
   */
  async prepareSettlement(evidence: VercelSettlementEvidence): Promise<void> {
    const existing = await loadVercelBillingBinding(this.deps.storage, evidence.generation);
    if (existing) {
      const merged: VercelBillingBinding = {
        ...existing,
        ...(evidence.createdAtMs !== undefined ? { createdAtMs: evidence.createdAtMs } : {}),
        ...(evidence.terminalAtMs !== undefined ? { terminalAtMs: evidence.terminalAtMs } : {}),
      };
      if (
        merged.createdAtMs !== existing.createdAtMs ||
        merged.terminalAtMs !== existing.terminalAtMs
      ) {
        await saveVercelBillingBinding(this.deps.storage, merged);
      }
    }
    await this.deps.schedule.markDue(
      VERCEL_BILLING_SETTLEMENT_CALLBACK,
      evidence.generation,
      Date.now()
    );
  }

  /**
   * Runs only after `prepareSettlement` returned. Pins the alive cursor when a
   * real lifetime has not been measured, ends settlement at the stored terminal
   * time (never `Date.now()`), then delivers through the heartbeat tick.
   *
   * The delivery is fenced to its generation: a delayed delivery for an older
   * generation must not stop a newer one. The pin is taken only when this
   * generation's binding supplies the create-response lifetime.
   */
  async deliverSettlement(generation: string): Promise<void> {
    let context = await getBillingContext(this.deps.storage);
    if (!context || context.generation !== generation) return;
    const binding = await loadVercelBillingBinding(this.deps.storage, generation);
    if (!context.measurementStarted && binding !== undefined && binding.generation === generation) {
      await this.deps.lifecycle.pinMeasurementCursor(generation, binding.createdAtMs);
      const pinned = await getBillingContext(this.deps.storage);
      if (!pinned || pinned.generation !== generation) return;
      context = pinned;
    }
    const end = binding?.terminalAtMs ?? context.usageMeasuredAtMs;
    await this.deps.heartbeat.persistStop({ reason: 'runtime_signal' }, end);
    await this.deps.heartbeat.billingHeartbeatTick(generation);
  }

  /**
   * Generation-close callback. Removes the binding and the continuation; `remove`
   * triggers the compose pass. It does not take the billing or heartbeat queue
   * and does not create anything.
   */
  async onGenerationClosed(context: BillingContext): Promise<void> {
    await deleteVercelBillingBinding(this.deps.storage, context.generation);
    await this.deps.schedule.remove(VERCEL_BILLING_SETTLEMENT_CALLBACK, context.generation);
  }
}
