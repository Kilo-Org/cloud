import { describe, expect, it } from 'vitest';
import {
  hasScopedStopMaintenanceFields,
  parseScopedStopMaintenance,
  stopAbortWirePayload,
} from './scoped-stop-maintenance.js';

const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

describe('scoped Stop maintenance', () => {
  it('requires a current immutable cleanup bound', () => {
    expect(
      parseScopedStopMaintenance(
        { messageId: 'a', operationId: OPERATION_ID, cleanupDeadlineAt: 11_000 },
        1_000
      )
    ).toEqual({ messageId: 'a', operationId: OPERATION_ID, cleanupDeadlineAt: 11_000 });
    expect(
      parseScopedStopMaintenance(
        { messageId: 'a', operationId: OPERATION_ID, cleanupDeadlineAt: 1_000 },
        1_000
      )
    ).toBeUndefined();
    expect(
      parseScopedStopMaintenance(
        { messageId: 'a', operationId: OPERATION_ID, cleanupDeadlineAt: 11_001 },
        1_000
      )
    ).toBeUndefined();
  });

  it('sends strict Stop fields only to a negotiated peer', () => {
    const payload = { messageId: 'a', operationId: OPERATION_ID, cleanupDeadlineAt: 11_000 };

    expect(stopAbortWirePayload(payload, true)).toEqual(payload);
    expect(stopAbortWirePayload(payload, false)).toEqual({ messageId: 'a' });
  });

  it('identifies incomplete strict Stop payloads so callers can fail closed', () => {
    expect(hasScopedStopMaintenanceFields({ messageId: 'a' })).toBe(false);
    expect(hasScopedStopMaintenanceFields({ messageId: 'a', operationId: OPERATION_ID })).toBe(
      true
    );
    expect(hasScopedStopMaintenanceFields({ cleanupDeadlineAt: 11_000 })).toBe(true);
  });
});
