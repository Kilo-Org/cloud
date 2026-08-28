export class StoreError extends Error {
  constructor(
    readonly code: 'storage_unavailable' | 'invalid_input' | 'limit_exceeded' | 'command_conflict',
    readonly retryable = false
  ) {
    super(code);
  }
}

export type AlarmStorage = Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm'>;
// wakeAt is the earliest deadline required by the change; null is reserved for wait-only changes.
type Prepared<T> = { value: T } | { wakeAt: number | null; commit: () => T };

// Both command handlers and alarm handlers use this gate. No network I/O belongs in prepare/commit.
export async function transitionWithWake<T>(
  state: DurableObjectState,
  prepare: () => Prepared<T>,
  alarms: AlarmStorage = state.storage
): Promise<T> {
  const outcome = await state.blockConcurrencyWhile(async () => {
    try {
      const prepared = prepare();
      if ('value' in prepared) return { ok: true, value: prepared.value } as const;
      if (prepared.wakeAt !== null) {
        if (!Number.isSafeInteger(prepared.wakeAt) || prepared.wakeAt < 0)
          throw new StoreError('invalid_input');
        try {
          const existing = await alarms.getAlarm();
          await alarms.setAlarm(Math.min(existing ?? prepared.wakeAt, prepared.wakeAt));
        } catch {
          throw new StoreError('storage_unavailable', true);
        }
      }
      // An armed but uncommitted wake is harmless. A committed transition always retains its wake.
      const value = state.storage.transactionSync(() => {
        const result = prepared.commit();
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          'then' in result
        ) {
          throw new StoreError('invalid_input');
        }
        return result;
      });
      return { ok: true, value } as const;
    } catch (error) {
      // Keep expected command failures from resetting the object through blockConcurrencyWhile.
      return { ok: false, error } as const;
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
