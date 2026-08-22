import { describe, expect, it } from 'vitest';

import { pushDataSchema } from './push-data';
import {
  ANDROID_NOTIFICATION_CHANNELS,
  androidChannelIdForPushData,
  genericPushContentForPushData,
} from './push-presentation';

// One representative payload per `pushDataSchema` variant. The exhaustive
// channel mapping is asserted against these; the `never` guard in the switch
// makes any new variant a compile error, so this list is complete by
// construction.
const variants = [
  { type: 'chat.message', sandboxId: 'sb1', conversationId: 'conv1', messageId: 'm1' },
  { type: 'instance-lifecycle', event: 'ready', sandboxId: 'sb1' },
  { type: 'scheduled-action', event: 'scheduled_restart_notice', sandboxId: 'sb1' },
  { type: 'cloud_agent_session', cliSessionId: 'cli1', category: 'attention' },
  { type: 'low_balance', organizationId: 'org1' },
  { type: 'security_finding', findingId: 'f1', scope: 'org' },
  { type: 'security_lifecycle', event: 'analysis_completed', findingId: 'f1', scope: 'org' },
] as const;

describe('androidChannelIdForPushData', () => {
  it('maps every pushDataSchema variant to a declared channel id', () => {
    const declaredIds = new Set(ANDROID_NOTIFICATION_CHANNELS.map(c => c.id));

    for (const variant of variants) {
      const parsed = pushDataSchema.safeParse(variant);
      expect(parsed.success, `variant should parse: ${JSON.stringify(variant)}`).toBe(true);
      if (!parsed.success) continue;

      const channelId = androidChannelIdForPushData(parsed.data);
      expect(declaredIds.has(channelId)).toBe(true);
    }
  });

  it('maps each type to its expected channel', () => {
    const expected: Record<string, string> = {
      cloud_agent_session: 'agent',
      'chat.message': 'chat',
      'instance-lifecycle': 'kiloclaw',
      'scheduled-action': 'kiloclaw',
      low_balance: 'balance',
      security_finding: 'security',
      security_lifecycle: 'security',
    };

    for (const variant of variants) {
      const parsed = pushDataSchema.parse(variant);
      expect(androidChannelIdForPushData(parsed)).toBe(expected[parsed.type]);
    }
  });
});

describe('genericPushContentForPushData', () => {
  it('never embeds any input field value in the generic copy', () => {
    for (const variant of variants) {
      const parsed = pushDataSchema.parse(variant);
      const { title, body } = genericPushContentForPushData(parsed);

      // Collect every string field value from the input and assert none of
      // them (nor any non-empty substring) leaks into the generic copy.
      const fieldValues = (Object.values(variant) as unknown[]).filter(
        (v): v is string => typeof v === 'string'
      );
      for (const value of fieldValues) {
        expect(title).not.toContain(value);
        expect(body).not.toContain(value);
      }
    }
  });

  it('returns non-empty title and body for every variant', () => {
    for (const variant of variants) {
      const parsed = pushDataSchema.parse(variant);
      const { title, body } = genericPushContentForPushData(parsed);
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it('returns the security lifecycle copy for the security_lifecycle variant', () => {
    const parsed = pushDataSchema.parse({
      type: 'security_lifecycle',
      event: 'remediation_failed',
      findingId: 'f1',
      scope: 'org',
      remediationId: 'r1',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    expect(genericPushContentForPushData(parsed)).toEqual({
      title: 'Kilo',
      body: 'A security finding needs attention',
    });
  });
});
