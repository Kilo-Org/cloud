import { describe, expect, it } from 'vitest';
import { pushDataSchema } from '@kilocode/notifications';

import { notificationPathForData } from './notification-path';

describe('pushDataSchema', () => {
  it('rejects empty chat notification IDs', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: '',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      }).success
    ).toBe(false);
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: '',
        messageId: 'message-1',
      }).success
    ).toBe(false);
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: '',
      }).success
    ).toBe(false);
  });

  it('accepts valid chat, lifecycle, and cloud agent notification data', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      }).success
    ).toBe(true);
    expect(
      pushDataSchema.safeParse({
        type: 'instance-lifecycle',
        event: 'ready',
        sandboxId: 'sandbox-1',
      }).success
    ).toBe(true);
    expect(
      pushDataSchema.safeParse({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
      }).success
    ).toBe(true);
  });

  it('accepts valid low_balance and security_finding notification data', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'low_balance',
        organizationId: 'org-abc',
      }).success
    ).toBe(true);
    expect(
      pushDataSchema.safeParse({
        type: 'security_finding',
        findingId: 'finding-1',
        scope: 'personal',
      }).success
    ).toBe(true);
    expect(
      pushDataSchema.safeParse({
        type: 'security_finding',
        findingId: 'finding-2',
        scope: 'org-xyz',
      }).success
    ).toBe(true);
  });

  it('parses low_balance and security_finding through the schema into notification paths', () => {
    const lowBalance = pushDataSchema.parse({
      type: 'low_balance',
      organizationId: 'org-parsed',
    });
    expect(notificationPathForData(lowBalance)).toBe(
      '/(app)/(tabs)/(3_profile)/organization/credit-activity?org=org-parsed&via=push'
    );

    const personalFinding = pushDataSchema.parse({
      type: 'security_finding',
      findingId: 'f-parsed',
      scope: 'personal',
    });
    expect(notificationPathForData(personalFinding)).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/f-parsed?via=push'
    );

    const orgFinding = pushDataSchema.parse({
      type: 'security_finding',
      findingId: 'f-org',
      scope: 'org-99',
    });
    expect(notificationPathForData(orgFinding)).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/org-99/findings/f-org?via=push'
    );
  });

  it('rejects empty cloud agent session IDs', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'cloud_agent_session',
        cliSessionId: '',
      }).success
    ).toBe(false);
  });

  it('rejects a security_lifecycle payload with an unknown event value', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'security_lifecycle',
        event: 'sla_warning',
        findingId: 'finding-1',
        scope: 'org-xyz',
      }).success
    ).toBe(false);
  });
});
