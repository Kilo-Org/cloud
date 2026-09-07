import { describe, expect, it } from 'vitest';
import {
  bindControlEventReceiptIdentity,
  controlEventReceiptDisposition,
  readControlEventReceipts,
  recordControlEventReceipt,
  retireControlEventReceiptIdentity,
} from './control-event-receipts.js';

const runtimeA = '11111111-1111-4111-8111-111111111111';
const runtimeB = '22222222-2222-4222-8222-222222222222';

function receipt(wrapperInstanceId: string, sequence: number) {
  return {
    receiptId: `${String(sequence).padStart(8, '0')}-1111-4111-8111-111111111111`,
    receiptHash: 'a'.repeat(64),
    wrapperInstanceId,
    sequence,
  };
}

function storage() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    put<T>(key: string, value: T): void {
      values.set(key, value);
    },
  };
}

describe('control event receipts', () => {
  it('preserves the stream on the same wrapper and retires it only when the admitted wrapper changes', () => {
    const state = storage();
    bindControlEventReceiptIdentity(state, runtimeA);
    recordControlEventReceipt(state, receipt(runtimeA, 2));
    bindControlEventReceiptIdentity(state, runtimeA);
    expect(controlEventReceiptDisposition(state, receipt(runtimeA, 1))).toBe('stale');
    expect(controlEventReceiptDisposition(state, receipt(runtimeA, 2))).toBe('duplicate');
    expect(controlEventReceiptDisposition(state, receipt(runtimeB, 1))).toBe('stale');

    bindControlEventReceiptIdentity(state, runtimeB);
    expect(controlEventReceiptDisposition(state, receipt(runtimeA, 3))).toBe('stale');
    expect(controlEventReceiptDisposition(state, receipt(runtimeB, 1))).toBe('apply');
    expect(() => bindControlEventReceiptIdentity(state, runtimeA)).toThrow('retired');
    expect(readControlEventReceipts(state).activeWrapperInstanceId).toBe(runtimeB);
  });

  it('does not derive the admitted wrapper identity from an event', () => {
    const state = storage();
    recordControlEventReceipt(state, receipt(runtimeA, 1));
    expect(readControlEventReceipts(state).activeWrapperInstanceId).toBeUndefined();
  });

  it('rejects a retired wrapper identity after pruning its receipt state', () => {
    const state = storage();
    const first = receipt(runtimeA, 1);
    recordControlEventReceipt(state, first);
    expect(controlEventReceiptDisposition(state, first)).toBe('duplicate');

    retireControlEventReceiptIdentity(state, runtimeA);
    expect(controlEventReceiptDisposition(state, first)).toBe('stale');

    const second = receipt(runtimeB, 1);
    recordControlEventReceipt(state, second);
    expect(controlEventReceiptDisposition(state, second)).toBe('duplicate');
    expect(controlEventReceiptDisposition(state, { ...first, sequence: 2 })).toBe('stale');
  });
});
