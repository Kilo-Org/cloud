import { describe, expect, it } from 'vitest';
import {
  intervalId,
  recordHeartbeatInputSchema,
  recordStartResultSchema,
  recordStartV2ResultSchema,
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

  it('keeps v1 starts stable while v2 reports paid admission details', () => {
    const v1 = {
      success: true,
      ack: { intervalId: 'interval-1', durable: 'pg', dedup: false },
    };
    expect(recordStartResultSchema.parse(v1)).toEqual(v1);
    expect(
      recordStartV2ResultSchema.parse({
        ...v1,
        billingMode: 'paid',
        remainingMicrodollars: 10_000_001,
      })
    ).toMatchObject({ success: true, billingMode: 'paid', remainingMicrodollars: 10_000_001 });
    expect(
      recordStartV2ResultSchema.parse({
        success: false,
        error: {
          code: 'insufficient_credits',
          message: 'Insufficient credits',
          remainingMicrodollars: 5_000_000,
          minimumRequiredMicrodollars: 5_000_000,
        },
      })
    ).toMatchObject({ success: false });
  });
});
