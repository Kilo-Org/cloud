import { describe, expect, it } from 'vitest';

import { notificationPathForData, prPathForData } from './notification-path';

describe('prPathForData', () => {
  it('routes a GitHub PR payload to the PR review route with via=push', () => {
    expect(
      prPathForData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        prUrl: 'https://github.com/org/repo/pull/7',
      })
    ).toBe('/(app)/pr-review/org/repo/7?via=push');
  });

  it('routes a GitLab MR payload to the provider route with its instance hint', () => {
    expect(
      prPathForData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        prUrl: 'https://gitlab.example.com/group/project/-/merge_requests/9',
      })
    ).toBe(
      '/(app)/pr-review/gitlab/group/project/9?instance=https%3A%2F%2Fgitlab.example.com&via=push'
    );
  });

  it('routes a Bitbucket PR payload to the provider route', () => {
    expect(
      prPathForData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        prUrl: 'https://bitbucket.org/workspace/repo/pull-requests/3',
      })
    ).toBe('/(app)/pr-review/bitbucket/workspace/repo/3?via=push');
  });

  it('returns null for a payload without a PR', () => {
    expect(prPathForData({ type: 'cloud_agent_session', cliSessionId: 'ses_1' })).toBeNull();
  });

  it('returns null for a PR URL the provider resolver cannot parse', () => {
    expect(
      prPathForData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        prUrl: 'https://docs.example.com/pull/1',
      })
    ).toBeNull();
  });
});

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

  it('routes active_agents_glanceable notifications to the agents tab', () => {
    expect(
      notificationPathForData({
        type: 'active_agents_glanceable',
        schemaVersion: 1,
        revision: 1,
        scopeKey: 'scope-1',
        organizationBound: false,
        status: 'happy',
        running: 1,
        needsInput: 0,
        idle: 0,
        scheduled: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T08:00:00.000Z',
        needsInputSince: '2026-01-01T00:00:00.000Z',
        scheduledAt: null,
        newestResultKind: 'running',
        newestResultAt: '2026-01-01T00:00:00.000Z',
      })
    ).toBe('/(app)/(tabs)/(2_agents)');
  });

  it('routes low_balance notifications to organization credit activity with via=push', () => {
    expect(
      notificationPathForData({
        type: 'low_balance',
        organizationId: 'org-abc',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/organization/credit-activity?org=org-abc&via=push');
  });

  it('routes spend_alert notifications for the personal scope to the spend view with via=push', () => {
    expect(
      notificationPathForData({
        type: 'spend_alert',
        scope: 'personal',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/spend-alerts?via=push');
  });

  it('routes spend_alert notifications for an organization scope to its spend view', () => {
    expect(
      notificationPathForData({
        type: 'spend_alert',
        scope: 'organization',
        organizationId: 'org-spend',
      })
    ).toBe('/(app)/(tabs)/(3_profile)/spend-alerts?org=org-spend&via=push');
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
