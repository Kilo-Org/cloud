import { describe, expect, it } from 'vitest';
import { recordStopInputSchema, usageContextSchema } from './contracts';

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
        reason: 'exit',
      }).success
    ).toBe(false);
  });
});
