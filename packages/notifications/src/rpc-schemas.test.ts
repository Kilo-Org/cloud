import { describe, expect, it } from 'vitest';
import {
  refreshGlanceableSessionsInputSchema,
  sendCloudAgentSessionNotificationInputSchema,
} from './rpc-schemas';

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

  it('passes the approval hint through for the glanceable delivery window', () => {
    const parsed = refreshGlanceableSessionsInputSchema.parse({
      userId: 'usr_1',
      cliSessionIds: ['ses_1'],
      approvalChanged: true,
    });
    expect(parsed.approvalChanged).toBe(true);
    // A refresh with no hint is a normal counts change: no window exemption.
    expect(
      refreshGlanceableSessionsInputSchema.parse({ userId: 'usr_1', cliSessionIds: ['ses_1'] })
        .approvalChanged
    ).toBeUndefined();
  });
});
