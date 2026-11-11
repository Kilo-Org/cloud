import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_TIMERS } from '../../shared/control-plane-timers.js';
import {
  clearNativeBillingAdmissionDeadline,
  nativeBillingAdmissionDeadlineAt,
  storedNativeBillingAdmissionDeadlineAt,
} from './native-billing-admission.js';

const timers = CONTROL_PLANE_TIMERS.sandbox;
const route = { state: 'preparing' as const, attemptId: 'attempt-1', attemptDeadlineAt: 720_000 };

function storage() {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key),
  };
}

describe('native billing admission deadline', () => {
  it('retains the admission boundary across allocation retries and reconstruction', async () => {
    const persisted = storage();
    expect(
      await nativeBillingAdmissionDeadlineAt(persisted, [route], 'allocation-1', timers, 1_000)
    ).toBe(61_000);
    expect(
      await nativeBillingAdmissionDeadlineAt(persisted, [route], 'allocation-2', timers, 50_000)
    ).toBe(61_000);
  });

  it('starts fresh after a healthy create or a new route attempt', async () => {
    const persisted = storage();
    await nativeBillingAdmissionDeadlineAt(persisted, [route], 'allocation-1', timers, 1_000);
    await clearNativeBillingAdmissionDeadline(persisted);
    expect(
      await nativeBillingAdmissionDeadlineAt(persisted, [route], 'allocation-2', timers, 90_000)
    ).toBe(150_000);
    expect(
      await nativeBillingAdmissionDeadlineAt(
        persisted,
        [{ ...route, attemptId: 'attempt-2' }],
        'allocation-3',
        timers,
        100_000
      )
    ).toBe(160_000);
  });

  it('does not shorten admission because an older route used preparation time', async () => {
    expect(
      await nativeBillingAdmissionDeadlineAt(storage(), [route], 'allocation-1', timers, 90_000)
    ).toBe(150_000);
  });
  it('does not use a retired route attempt to schedule a new allocation', async () => {
    const persisted = storage();
    await nativeBillingAdmissionDeadlineAt(persisted, [route], 'allocation-1', timers, 1_000);
    expect(await storedNativeBillingAdmissionDeadlineAt(persisted, [route], 'allocation-2')).toBe(
      61_000
    );
    expect(
      await storedNativeBillingAdmissionDeadlineAt(
        persisted,
        [{ ...route, attemptId: 'new-attempt' }],
        'allocation-2'
      )
    ).toBeUndefined();
  });
});
