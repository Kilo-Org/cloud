import { describe, expect, it } from 'vitest';
import {
  intervalId,
  recordHeartbeatInputSchema,
  recordStartInputSchema,
  recordStartResultSchema,
  recordStopInputSchema,
  usageContextSchema,
} from './contracts';

const personalContext = {
  service: 'cloud-agent-next',
  instanceId: 'instance-1',
  sku: 'cloud-agent-next:Sandbox',
  subject: { type: 'user' as const, id: 'user-1' },
  actor: { type: 'user' as const, id: 'user-1' },
};

describe('container usage contracts', () => {
  it('enforces actor delegation against the billing subject', () => {
    expect(
      usageContextSchema.safeParse({
        ...personalContext,
        actor: { type: 'bot', id: 'bot-1' },
      }).success
    ).toBe(false);
    expect(
      usageContextSchema.safeParse({
        ...personalContext,
        actor: { type: 'bot', id: 'bot-1' },
        onBehalfOf: personalContext.subject,
      }).success
    ).toBe(true);
    expect(
      usageContextSchema.safeParse({
        ...personalContext,
        onBehalfOf: personalContext.subject,
      }).success
    ).toBe(false);
  });

  it('requires stop context so stop-before-start can self-heal', () => {
    expect(
      recordStopInputSchema.safeParse({
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 123,
        idempotencyKey: 'key',
        seq: 2,
        usageSinceLast: 3,
        reason: 'exit',
      }).success
    ).toBe(false);
  });

  it('accepts whole-second heartbeat quantities and bounded exit codes', () => {
    expect(
      recordHeartbeatInputSchema.safeParse({
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 123,
        idempotencyKey: 'key',
        seq: 1,
        usageSinceLast: 1.5,
        context: personalContext,
      }).success
    ).toBe(false);
    expect(
      recordStopInputSchema.safeParse({
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 123,
        idempotencyKey: 'key',
        seq: 2,
        usageSinceLast: 3,
        reason: 'exit',
        exitCode: 255,
        context: personalContext,
      }).success
    ).toBe(true);
    expect(
      recordStopInputSchema.safeParse({
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 123,
        idempotencyKey: 'key',
        reason: 'exit',
        exitCode: 256,
        context: personalContext,
      }).success
    ).toBe(false);
  });

  it('rejects producer timestamps because billing uses meter receive time', () => {
    expect(
      recordHeartbeatInputSchema.safeParse({
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 123,
        idempotencyKey: 'key',
        seq: 1,
        observedAt: 456,
        context: personalContext,
      }).success
    ).toBe(false);
    expect(
      recordStopInputSchema.safeParse({
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 123,
        idempotencyKey: 'key',
        seq: 2,
        usageSinceLast: 3,
        reason: 'exit',
        stoppedAt: 456,
        context: personalContext,
      }).success
    ).toBe(false);
  });

  it('scopes interval identity to the producer service', () => {
    expect(intervalId('cloud-agent-next', 'shared-instance', 123)).not.toBe(
      intervalId('gastown', 'shared-instance', 123)
    );
  });

  it.each(['control-plane-create', 'sandbox-start'] as const)(
    'accepts optional capacity admission at %s without changing usage context',
    checkpoint => {
      const start = { ...personalContext, startEpochMs: 123, idempotencyKey: 'key' };
      expect(recordStartInputSchema.parse(start)).toEqual(start);
      expect(recordStartInputSchema.parse({ ...start, admission: { checkpoint } })).toEqual({
        ...start,
        admission: { checkpoint },
      });
      expect(
        recordStartInputSchema.safeParse({ ...start, admission: { checkpoint: 'other' } }).success
      ).toBe(false);
    }
  );

  it('requires complete, recognizable container-limit rejection details', () => {
    const error = {
      code: 'container_limit_reached',
      message: 'container_limit_reached: Stop an existing container',
      accountType: 'organization',
      limit: 50,
    };
    expect(recordStartResultSchema.parse({ success: false, error })).toEqual({
      success: false,
      error,
    });
    expect(
      recordStartResultSchema.safeParse({ success: false, error: { ...error, limit: undefined } })
        .success
    ).toBe(false);
    expect(
      recordStartResultSchema.safeParse({
        success: false,
        error: { ...error, accountType: undefined },
      }).success
    ).toBe(false);
    expect(
      recordStartResultSchema.safeParse({
        success: false,
        error: { ...error, message: 'unrelated' },
      }).success
    ).toBe(false);
  });

  it('accepts a distinct closed-interval rejection', () => {
    const result = {
      success: false,
      error: { code: 'interval_closed', message: 'The container reservation has ended' },
    };
    expect(recordStartResultSchema.parse(result)).toEqual(result);
  });

  it('keeps successful starts minimal and preserves insufficient-credit details', () => {
    const v1 = {
      success: true,
      ack: { intervalId: 'interval-1', durable: 'pg', dedup: false },
    };
    expect(recordStartResultSchema.parse(v1)).toEqual(v1);
    expect(
      recordStartResultSchema.parse({
        success: false,
        error: {
          code: 'insufficient_credits',
          message: 'Insufficient credits',
          remainingMicrodollars: 5_000_000,
          minimumRequiredMicrodollars: 5_000_000,
        },
      })
    ).toMatchObject({ success: false, error: { code: 'insufficient_credits' } });
  });
});
