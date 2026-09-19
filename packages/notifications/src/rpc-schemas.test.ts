import { describe, expect, it } from 'vitest';
import {
  internalDispatchRequestSchema,
  internalDispatchSpendAlertRequestSchema,
  refreshGlanceableSessionsInputSchema,
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
