import type { SandboxTimers } from './allocation.js';
import type { RouteRecord } from './routes.js';
import { z } from 'zod';

const DEADLINE_KEY = 'native_billing_admission_deadline';
const deadlineSchema = z
  .object({ attemptId: z.string(), deadlineAt: z.number().int().nonnegative() })
  .strict();

type AdmissionDeadlineStorage = {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
};

export async function nativeBillingAdmissionDeadlineAt(
  storage: Pick<AdmissionDeadlineStorage, 'get' | 'put'>,
  routes: readonly Pick<RouteRecord, 'state' | 'attemptId' | 'attemptDeadlineAt'>[],
  allocationId: string,
  timers: Pick<SandboxTimers, 'billingAdmissionMs'>,
  now: number
): Promise<number> {
  const route = routes
    .filter(route => route.state === 'preparing')
    .sort((a, b) => a.attemptDeadlineAt - b.attemptDeadlineAt)[0];
  const attemptId = route?.attemptId ?? allocationId;
  const stored = await storage.get(DEADLINE_KEY);
  const deadline = stored === undefined ? undefined : deadlineSchema.parse(stored);
  if (deadline?.attemptId === attemptId) return deadline.deadlineAt;
  const deadlineAt = now + timers.billingAdmissionMs;
  await storage.put(DEADLINE_KEY, { attemptId, deadlineAt });
  return deadlineAt;
}

export async function clearNativeBillingAdmissionDeadline(
  storage: Pick<AdmissionDeadlineStorage, 'delete'>
): Promise<void> {
  await storage.delete(DEADLINE_KEY);
}

export async function storedNativeBillingAdmissionDeadlineAt(
  storage: Pick<AdmissionDeadlineStorage, 'get'>,
  routes: readonly Pick<RouteRecord, 'state' | 'attemptId'>[],
  allocationId: string | null
): Promise<number | undefined> {
  const stored = deadlineSchema.safeParse(await storage.get(DEADLINE_KEY));
  if (!stored.success) return undefined;
  return stored.data.attemptId === allocationId ||
    routes.some(route => route.state === 'preparing' && route.attemptId === stored.data.attemptId)
    ? stored.data.deadlineAt
    : undefined;
}
