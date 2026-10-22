import { describe, expect, it } from 'vitest';
import {
  internalDispatchRequestSchema,
  internalDispatchSpendAlertRequestSchema,
  refreshGlanceableSessionsInputSchema,
  sendCloudAgentSessionNotificationInputSchema,
} from './rpc-schemas';

describe('agent briefing dispatch', () => {
  const request = {
    kind: 'agent_briefing',
    userId: 'oauth/github/123',
    localDate: '2026-10-15',
    expiresAt: '2026-10-15T12:00:00.000Z',
  };

  it('accepts a user-scoped dispatch with a local calendar date and UTC expiry', () => {
    expect(internalDispatchRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    { userId: '' },
    { localDate: '2026-02-30' },
    { localDate: '2026-10-15T00:00:00.000Z' },
    { expiresAt: 'not-a-date' },
    { expiresAt: undefined },
  ])('rejects invalid briefing dispatch identity or expiry: %j', invalid => {
    expect(internalDispatchRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(false);
  });
});

describe('internalDispatchSpendAlertRequestSchema', () => {
  const personal = {
    kind: 'spend_alert',
    recipientUserIds: ['user-a'],
    scope: 'personal',
    alertKind: 'threshold',
    scopeName: 'you',
    amountUsd: 42.5,
    thresholdUsd: 40,
    dedupeKey: 'user:user-a:threshold:push:2026-01-01T00:00:00.000Z:armed',
  };

  it('parses a personal-scope request without an organizationId', () => {
    expect(internalDispatchSpendAlertRequestSchema.parse(personal)).toEqual(personal);
  });

  it('parses an organization-scope request carrying its organizationId', () => {
    const payload = { ...personal, scope: 'organization', organizationId: 'org-1' };
    expect(internalDispatchSpendAlertRequestSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an empty recipient list', () => {
    expect(
      internalDispatchSpendAlertRequestSchema.safeParse({ ...personal, recipientUserIds: [] })
        .success
    ).toBe(false);
  });

  it('rejects an unknown scope or alert kind', () => {
    expect(
      internalDispatchSpendAlertRequestSchema.safeParse({ ...personal, scope: 'team' }).success
    ).toBe(false);
    expect(
      internalDispatchSpendAlertRequestSchema.safeParse({ ...personal, alertKind: 'budget' })
        .success
    ).toBe(false);
  });

  it('rejects a scope and an organizationId that disagree', () => {
    expect(
      internalDispatchSpendAlertRequestSchema.safeParse({ ...personal, scope: 'organization' })
        .success
    ).toBe(false);
    expect(
      internalDispatchSpendAlertRequestSchema.safeParse({ ...personal, organizationId: 'org-1' })
        .success
    ).toBe(false);
  });

  it('is accepted by the internal dispatch union', () => {
    expect(internalDispatchRequestSchema.safeParse(personal).success).toBe(true);
  });

  it('requires the outbox dedupe key that carries the firing episode', () => {
    const withoutKey: Record<string, unknown> = { ...personal };
    delete withoutKey.dedupeKey;
    expect(internalDispatchSpendAlertRequestSchema.safeParse(withoutKey).success).toBe(false);
    expect(
      internalDispatchSpendAlertRequestSchema.safeParse({ ...personal, dedupeKey: '' }).success
    ).toBe(false);
  });
});

const cloudAgentSessionBase = {
  userId: 'usr_1',
  cliSessionId: 'cli_1',
  executionId: 'exec_1',
  status: 'completed',
  body: 'Waiting for your input',
} as const;

describe('sendCloudAgentSessionNotificationInputSchema', () => {
  it('accepts the optional attentionKind and prUrl of a needs-input raise', () => {
    const input = {
      ...cloudAgentSessionBase,
      category: 'attention',
      attentionKind: 'question',
      prUrl: 'https://github.com/org/repo/pull/1',
    };
    expect(sendCloudAgentSessionNotificationInputSchema.parse(input)).toEqual(input);
  });

  it('keeps attentionKind and prUrl optional for old producers', () => {
    expect(sendCloudAgentSessionNotificationInputSchema.parse(cloudAgentSessionBase)).toEqual(
      cloudAgentSessionBase
    );
  });

  it('rejects an attentionKind the app cannot render actions for', () => {
    expect(
      sendCloudAgentSessionNotificationInputSchema.safeParse({
        ...cloudAgentSessionBase,
        attentionKind: 'unknown',
      }).success
    ).toBe(false);
  });

  it('rejects a non-string prUrl', () => {
    expect(
      sendCloudAgentSessionNotificationInputSchema.safeParse({
        ...cloudAgentSessionBase,
        prUrl: 42,
      }).success
    ).toBe(false);
  });

  it('rejects an empty prUrl the notification could not open', () => {
    expect(
      sendCloudAgentSessionNotificationInputSchema.safeParse({
        ...cloudAgentSessionBase,
        prUrl: '',
      }).success
    ).toBe(false);
  });
});

describe('refreshGlanceableSessionsInputSchema', () => {
  it.each([
    { userId: '', cliSessionIds: ['ses_1'] },
    { userId: 'usr_1', cliSessionIds: [] },
    { userId: 'usr_1', cliSessionIds: [''] },
    { userId: 'usr_1', cliSessionIds: [42] },
  ])('rejects invalid refresh identity: %j', input => {
    expect(refreshGlanceableSessionsInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts OAuth user IDs without imposing UUID validation', () => {
    expect(
      refreshGlanceableSessionsInputSchema.safeParse({
        userId: 'oauth/github/123',
        cliSessionIds: ['ses_1', 'ses_2'],
      }).success
    ).toBe(true);
  });

  it('does not forward caller-supplied counts or organization scope', () => {
    const parsed = refreshGlanceableSessionsInputSchema.parse({
      userId: 'usr_1',
      cliSessionIds: ['ses_1'],
      organizationId: 'org_foreign',
      running: 100,
    });
    expect(parsed).not.toHaveProperty('organizationId');
    expect(parsed).not.toHaveProperty('running');
  });

  it('passes the approval hint through for the glanceable delivery window', () => {
    const parsed = refreshGlanceableSessionsInputSchema.parse({
      userId: 'usr_1',
      cliSessionIds: ['ses_1', 'ses_2'],
      approvalChangedSessionIds: ['ses_2'],
    });
    expect(parsed.approvalChangedSessionIds).toEqual(['ses_2']);
    // A refresh with no hint is a normal counts change: no window exemption.
    expect(
      refreshGlanceableSessionsInputSchema.parse({ userId: 'usr_1', cliSessionIds: ['ses_1'] })
        .approvalChangedSessionIds
    ).toBeUndefined();
  });
});
