import { describe, expect, it } from 'vitest';

import { pushDataSchema } from './push-data';
import {
  ANDROID_AGENT_CHANNELS_MIN_APP_VERSION,
  ANDROID_NOTIFICATION_CHANNELS,
  LEGACY_ANDROID_AGENT_CHANNEL_ID,
  androidChannelIdForPushData,
  androidChannelIdForPushDataAtAppVersion,
  genericPushContentForPushData,
} from './push-presentation';

// One representative payload per `pushDataSchema` variant, plus both
// `cloud_agent_session` categories (attention vs status vs absent). The
// `never` guard in the channel switch makes a new variant a compile error, so
// this list is complete by construction.
const channelCases = [
  [{ type: 'chat.message', sandboxId: 'sb1', conversationId: 'conv1', messageId: 'm1' }, 'chat'],
  [{ type: 'instance-lifecycle', event: 'ready', sandboxId: 'sb1' }, 'kiloclaw'],
  [{ type: 'scheduled-action', event: 'scheduled_restart_notice', sandboxId: 'sb1' }, 'kiloclaw'],
  [
    {
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'attention',
      attentionKind: 'question',
      prUrl: 'https://github.com/org/repo/pull/7',
    },
    'agent-attention',
  ],
  [{ type: 'cloud_agent_session', cliSessionId: 'cli1', category: 'status' }, 'agent-progress'],
  [{ type: 'cloud_agent_session', cliSessionId: 'cli1' }, 'agent-progress'],
  [{ type: 'low_balance', organizationId: 'org1' }, 'balance'],
  [{ type: 'security_finding', findingId: 'f1', scope: 'org' }, 'security'],
  [
    { type: 'security_lifecycle', event: 'analysis_completed', findingId: 'f1', scope: 'org' },
    'security',
  ],
  [
    {
      type: 'active_agents_glanceable',
      schemaVersion: 1,
      revision: 1,
      scopeKey: 'scope-1',
      organizationBound: false,
      status: 'happy',
      running: 1,
      needsInput: 0,
      idle: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T08:00:00.000Z',
      needsInputSince: '2026-01-01T00:00:00.000Z',
    },
    'active-agents',
  ],
] as const;

describe('androidChannelIdForPushData', () => {
  it('maps every pushDataSchema variant to its declared channel', () => {
    const declaredIds = new Set(ANDROID_NOTIFICATION_CHANNELS.map(c => c.id));

    for (const [variant, expectedChannelId] of channelCases) {
      const parsed = pushDataSchema.safeParse(variant);
      expect(parsed.success, `variant should parse: ${JSON.stringify(variant)}`).toBe(true);
      if (!parsed.success) continue;

      expect(declaredIds.has(expectedChannelId)).toBe(true);
      expect(androidChannelIdForPushData(parsed.data)).toBe(expectedChannelId);
    }
  });

  it('puts needs-input raises on the high-importance channel and progress on the quiet one', () => {
    const attention = ANDROID_NOTIFICATION_CHANNELS.find(c => c.id === 'agent-attention');
    const progress = ANDROID_NOTIFICATION_CHANNELS.find(c => c.id === 'agent-progress');

    expect(attention?.importance).toBe('high');
    expect(progress?.importance).toBe('default');
    // The two channels must not be the same channel id.
    expect(attention?.id).not.toBe(progress?.id);
  });

  it('never routes progress to a channel id an existing install created as high', () => {
    // Android keeps the importance of a channel that already exists, so
    // lowering a channel's importance is a no-op. Progress must therefore have
    // an id of its own: reusing `agent` (created high before this contract)
    // would keep ordinary progress breaking through on existing installs.
    expect(androidChannelIdForPushData({ type: 'cloud_agent_session', cliSessionId: 'cli1' })).toBe(
      'agent-progress'
    );
    expect(ANDROID_NOTIFICATION_CHANNELS.map(c => c.id)).not.toContain('agent');
  });
});

describe('androidChannelIdForPushDataAtAppVersion', () => {
  const attention = { type: 'cloud_agent_session', cliSessionId: 'cli1', category: 'attention' };
  const progress = { type: 'cloud_agent_session', cliSessionId: 'cli1' };

  it('routes a pre-split install to the legacy channel it actually created', () => {
    // These installs registered a non-null version but predate the split, so
    // they never created `agent-attention`/`agent-progress`; Android 8+ would
    // drop a push addressed to either. `1.0.11` is the last version released
    // without the split, so it must stay below the gate.
    for (const version of ['1.0.10', '1.0.11']) {
      expect(
        androidChannelIdForPushDataAtAppVersion(pushDataSchema.parse(attention), version)
      ).toBe(LEGACY_ANDROID_AGENT_CHANNEL_ID);
      expect(androidChannelIdForPushDataAtAppVersion(pushDataSchema.parse(progress), version)).toBe(
        LEGACY_ANDROID_AGENT_CHANNEL_ID
      );
    }
  });

  it('routes a split install to the split channel', () => {
    expect(
      androidChannelIdForPushDataAtAppVersion(
        pushDataSchema.parse(attention),
        ANDROID_AGENT_CHANNELS_MIN_APP_VERSION
      )
    ).toBe('agent-attention');
    expect(androidChannelIdForPushDataAtAppVersion(pushDataSchema.parse(progress), '1.2.0')).toBe(
      'agent-progress'
    );
  });

  it('treats an unknown version as pre-split', () => {
    for (const version of [null, undefined, '', 'not-a-version']) {
      expect(androidChannelIdForPushDataAtAppVersion(pushDataSchema.parse(progress), version)).toBe(
        LEGACY_ANDROID_AGENT_CHANNEL_ID
      );
    }
  });

  it('leaves every other channel ungated', () => {
    // Only the agent split is new; chat and the rest are created by every
    // install, so their id must not move with the version.
    const chat = pushDataSchema.parse({
      type: 'chat.message',
      sandboxId: 'sb1',
      conversationId: 'conv1',
      messageId: 'm1',
    });
    expect(androidChannelIdForPushDataAtAppVersion(chat, '1.0.0')).toBe('chat');
    expect(androidChannelIdForPushDataAtAppVersion(chat, null)).toBe('chat');
  });
});

describe('genericPushContentForPushData', () => {
  it('never embeds any input field value in the generic copy', () => {
    for (const [variant] of channelCases) {
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
    for (const [variant] of channelCases) {
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

  it('translates the generic copy for the es locale', () => {
    const parsed = pushDataSchema.parse({
      type: 'chat.message',
      sandboxId: 'sb1',
      conversationId: 'conv1',
      messageId: 'm1',
    });
    expect(genericPushContentForPushData(parsed, 'es')).toEqual({
      title: 'Kilo',
      body: 'Tienes un mensaje nuevo',
    });
  });

  it('falls back to English for an unknown locale', () => {
    const parsed = pushDataSchema.parse({
      type: 'low_balance',
      organizationId: 'org1',
    });
    expect(genericPushContentForPushData(parsed, 'xx')).toEqual({
      title: 'Kilo',
      body: 'Your balance needs attention',
    });
  });
});
