import { describe, expect, it } from 'vitest';
import {
  hasScopedStopMaintenanceFields,
  parseScopedStopMaintenance,
  stopAbortWirePayload,
} from './scoped-stop-maintenance.js';
import {
  sessionAbortPayloadSchema,
  sessionAbortResultSchema,
} from '../shared/sandbox-control-protocol.js';

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

  it('rejects root-scoped results that claim physical quiescence or retirement', () => {
    expect(
      sessionAbortResultSchema.safeParse({
        status: 'aborted',
        quiescent: true,
        cleanupScope: 'root',
      }).success
    ).toBe(false);
    expect(
      sessionAbortResultSchema.safeParse({
        status: 'aborted',
        quiescent: false,
        cleanupScope: 'root',
        runtimeRetired: true,
      }).success
    ).toBe(false);
    expect(
      sessionAbortResultSchema.safeParse({
        status: 'unconfirmed',
        quiescent: false,
        cleanupScope: 'root',
      }).success
    ).toBe(true);
  });

  it('does not accept request-side cleanup scope from a Stop caller', () => {
    expect(
      sessionAbortPayloadSchema.safeParse({
        messageId: 'a',
        operationId: '11111111-1111-4111-8111-111111111111',
        cleanupDeadlineAt: Date.now() + 1_000,
        cleanupScope: 'root',
      }).success
    ).toBe(false);
  });
});
