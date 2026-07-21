import { z } from 'zod';
import { usageContextFingerprint, usageContextSchema, type UsageContext } from './contracts';

const BILLING_CONTEXT_STORAGE_KEY = 'container-usage:billing-context:v1';

export const billingContextSchema = usageContextSchema
  .extend({
    startEpochMs: z.number().int().nonnegative().finite(),
    generation: z.uuid(),
    measurementStarted: z.boolean(),
    nextSeq: z.number().int().positive().max(2_147_483_647).default(1),
    usageMeasuredAtMs: z.number().int().nonnegative().finite(),
    pendingHeartbeat: z
      .object({
        seq: z.number().int().positive().finite(),
        usageSinceLast: z.number().int().nonnegative().max(2_147_483_647),
        measuredAtMs: z.number().int().nonnegative().finite(),
      })
      .strict()
      .optional(),
    pendingStop: z
      .object({
        seq: z.number().int().positive().max(2_147_483_647),
        usageSinceLast: z.number().int().nonnegative().max(2_147_483_647),
        measuredAtMs: z.number().int().nonnegative().finite(),
        reason: z.enum(['exit', 'runtime_signal', 'activity_expired']),
        exitCode: z.number().int().min(-256).max(255).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BillingContext = z.infer<typeof billingContextSchema>;
export type SetBillingContextInput = UsageContext & { startEpochMs: number };

export type BillingContextStorage = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
};

export async function setBillingContext(
  storage: BillingContextStorage,
  input: SetBillingContextInput
): Promise<BillingContext> {
  const { startEpochMs, ...candidateContext } = input;
  const usageContext = usageContextSchema.parse(candidateContext);
  const existing = await getBillingContext(storage);
  if (
    existing &&
    existing.service === usageContext.service &&
    existing.instanceId === usageContext.instanceId &&
    existing.startEpochMs === startEpochMs
  ) {
    const [existingFingerprint, candidateFingerprint] = await Promise.all([
      usageContextFingerprint(usageContextFromBillingContext(existing)),
      usageContextFingerprint(usageContext),
    ]);
    if (existingFingerprint !== candidateFingerprint) {
      throw new Error('Billing context cannot change within an active interval');
    }
    return existing;
  }

  const context = billingContextSchema.parse({
    ...usageContext,
    startEpochMs,
    generation: crypto.randomUUID(),
    measurementStarted: false,
    nextSeq: 1,
    usageMeasuredAtMs: Date.now(),
    pendingHeartbeat: undefined,
    pendingStop: undefined,
  });
  await storage.put(BILLING_CONTEXT_STORAGE_KEY, context);
  return context;
}

export async function getBillingContext(
  storage: BillingContextStorage
): Promise<BillingContext | undefined> {
  const stored = await storage.get(BILLING_CONTEXT_STORAGE_KEY);
  if (stored === undefined) return undefined;
  return billingContextSchema.parse(stored);
}

export async function updateBillingContext(
  storage: BillingContextStorage,
  context: BillingContext
): Promise<void> {
  await storage.put(BILLING_CONTEXT_STORAGE_KEY, billingContextSchema.parse(context));
}

export async function clearBillingContext(storage: BillingContextStorage): Promise<void> {
  await storage.delete(BILLING_CONTEXT_STORAGE_KEY);
}

export function isSameBillingGeneration(left: BillingContext, right: BillingContext): boolean {
  return left.generation === right.generation;
}

export function usageContextFromBillingContext(context: BillingContext): UsageContext {
  return usageContextSchema.parse({
    service: context.service,
    instanceId: context.instanceId,
    sku: context.sku,
    subject: context.subject,
    actor: context.actor,
    onBehalfOf: context.onBehalfOf,
    sessionId: context.sessionId,
    metadata: context.metadata,
  });
}
