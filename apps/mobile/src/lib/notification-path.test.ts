import { describe, expect, it } from 'vitest';
import { pushDataSchema } from '@kilocode/notifications';

import { notificationPathForData } from './notification-path';

describe('notificationPathForData', () => {
  it('routes chat message notifications to the conversation screen', () => {
    expect(
      notificationPathForData({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toBe('/(app)/(tabs)/(1_kiloclaw)/chat/sandbox-1/conversation-1?via=push');
  });

  it('keeps notifications on the tab-owned KiloClaw chat route', () => {
    expect(
      notificationPathForData({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toContain('/(app)/(tabs)/(1_kiloclaw)/chat/sandbox-1/');
  });

  it('routes ready lifecycle notifications with legacy sandbox IDs to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'ready',
        sandboxId: 'abcDEF123_-',
      })
    ).toBe('/(app)/(tabs)/(1_kiloclaw)/chat/abcDEF123_-');
  });

  it('routes start_failed lifecycle notifications with ki sandbox IDs to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'start_failed',
        sandboxId: 'ki_deadbeef',
      })
    ).toBe('/(app)/(tabs)/(1_kiloclaw)/chat/ki_deadbeef');
  });

  it('routes cloud agent notifications to the matching agent session', () => {
    expect(
      notificationPathForData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
      })
    ).toBe('/(app)/agent-chat/ses_1?via=push');
  });

  it('routes low_balance notifications to organization credit activity with via=push', () => {
    expect(
      notificationPathForData({
        type: 'low_balance',
        organizationId: 'org-abc',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/organization/credit-activity?org=org-abc&via=push');
  });

  it('routes security_finding notifications for personal scope', () => {
    expect(
      notificationPathForData({
        type: 'security_finding',
        findingId: 'finding-1',
        scope: 'personal',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1?via=push');
  });

  it('routes security_finding notifications for an organization scope', () => {
    expect(
      notificationPathForData({
        type: 'security_finding',
        findingId: 'finding-2',
        scope: 'org-xyz',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/security-agent/org-xyz/findings/finding-2?via=push');
  });

  it('routes every security_lifecycle event value to the finding detail path', () => {
    const events = [
      'analysis_completed',
      'analysis_failed',
      'remediation_queued',
      'remediation_pr_opened',
      'remediation_failed',
      'remediation_blocked',
      'remediation_no_changes_needed',
      'remediation_cancelled',
    ] as const;

    for (const event of events) {
      expect(
        notificationPathForData({
          type: 'security_lifecycle',
          event,
          findingId: 'finding-3',
          scope: 'personal',
        })
      ).toBe('/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-3?via=push');
    }
  });

  it('routes security_lifecycle notifications for an organization scope', () => {
    expect(
      notificationPathForData({
        type: 'security_lifecycle',
        event: 'remediation_pr_opened',
        findingId: 'finding-4',
        scope: 'org-xyz',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/security-agent/org-xyz/findings/finding-4?via=push');
  });
});

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
