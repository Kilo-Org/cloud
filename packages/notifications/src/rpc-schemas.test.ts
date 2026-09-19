import { describe, expect, it } from 'vitest';
import {
  internalDispatchRequestSchema,
  internalDispatchSpendAlertRequestSchema,
  refreshGlanceableSessionsInputSchema,
  sendCloudAgentSessionNotificationInputSchema,
} from './rpc-schemas';

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
});
