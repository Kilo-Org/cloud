import { describe, expect, it } from 'vitest';

import { pushDataSchema } from './push-data';
import {
  AGENT_CHANNEL_SPLIT_APP_VERSION,
  AGENT_NOTIFICATION_KINDS,
  ANDROID_AGENT_KIND_CHANNELS_MIN_APP_VERSION,
  ANDROID_NOTIFICATION_CHANNELS,
  agentNotificationKindForAndroidChannelId,
  agentNotificationKindForGlanceableSnapshot,
  agentNotificationKindForPushData,
  androidChannelIdForAgentKind,
  androidChannelIdForPushData,
  androidChannelIdForPushDataToAppVersion,
  LEGACY_AGENT_ANDROID_CHANNEL_ID,
  androidChannelIdForRegisteredClient,
  genericPushContentForPushData,
  iosInterruptionLevelForPushData,
  iosMutableContentForPushData,
} from './push-presentation';

// One representative payload per `pushDataSchema` variant, plus both
// `cloud_agent_session` categories (attention vs status vs absent). The
// `never` guard in the channel switch makes a new variant a compile error, so
// this list is complete by construction.
const channelCases = [
  [
    { type: 'chat.message', sandboxId: 'sb1', conversationId: 'conv1', messageId: 'm1' },
    'needs-input',
  ],
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
    'needs-input',
  ],
  [{ type: 'cloud_agent_session', cliSessionId: 'cli1', category: 'status' }, 'agent-progress'],
  [{ type: 'cloud_agent_session', cliSessionId: 'cli1' }, 'agent-progress'],
  [{ type: 'low_balance', organizationId: 'org1' }, 'balance'],
  [{ type: 'spend_alert', scope: 'organization', organizationId: 'org1' }, 'balance'],
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
    'agent-progress',
  ],
] as const;

function glanceable(needsInput: number) {
  return pushDataSchema.parse({
    type: 'active_agents_glanceable',
    schemaVersion: 1,
    revision: 1,
    scopeKey: 'scope-1',
    organizationBound: false,
    status: 'happy',
    running: 1,
    needsInput,
    idle: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T08:00:00.000Z',
    needsInputSince: '2026-01-01T00:00:00.000Z',
  });
}

describe('ANDROID_NOTIFICATION_CHANNELS', () => {
  it('declares the two named kinds plus the unchanged feature channels', () => {
    expect(ANDROID_NOTIFICATION_CHANNELS).toEqual([
      { id: 'needs-input', name: 'Needs input', importance: 'high', bypassDnd: true },
      { id: 'agent-progress', name: 'Agent progress', importance: 'default', bypassDnd: false },
      { id: 'kiloclaw', name: 'KiloClaw activity', importance: 'default', bypassDnd: false },
      { id: 'balance', name: 'Balance alerts', importance: 'default', bypassDnd: false },
      { id: 'security', name: 'Security findings', importance: 'high', bypassDnd: false },
    ]);
  });

  it('gives every channel a boolean bypassDnd, true only for needs-input', () => {
    for (const channel of ANDROID_NOTIFICATION_CHANNELS) {
      expect(typeof channel.bypassDnd).toBe('boolean');
    }
    const bypassing = ANDROID_NOTIFICATION_CHANNELS.filter(channel => channel.bypassDnd).map(
      channel => channel.id
    );
    expect(bypassing).toEqual(['needs-input']);
  });
});

describe('AGENT_NOTIFICATION_KINDS', () => {
  it('names exactly needs-input and progress', () => {
    expect(AGENT_NOTIFICATION_KINDS).toEqual(['needs-input', 'progress']);
  });
});

describe('agentNotificationKindForPushData', () => {
  it('maps an attention cloud agent session to needs-input', () => {
    const parsed = pushDataSchema.parse({
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'attention',
    });
    expect(agentNotificationKindForPushData(parsed)).toBe('needs-input');
  });

  it('maps a status cloud agent session to progress', () => {
    const parsed = pushDataSchema.parse({
      type: 'cloud_agent_session',
      cliSessionId: 'cli1',
      category: 'status',
    });
    expect(agentNotificationKindForPushData(parsed)).toBe('progress');
  });

  it('maps an omitted category (the schema default of status) to progress', () => {
    const parsed = pushDataSchema.parse({ type: 'cloud_agent_session', cliSessionId: 'cli1' });
    expect(agentNotificationKindForPushData(parsed)).toBe('progress');
  });

  it('maps a chat.message to needs-input', () => {
    const parsed = pushDataSchema.parse({
      type: 'chat.message',
      sandboxId: 'sb1',
      conversationId: 'conv1',
      messageId: 'm1',
    });
    expect(agentNotificationKindForPushData(parsed)).toBe('needs-input');
  });

  it.each([
    [0, 'progress'],
    [1, 'needs-input'],
    [2, 'needs-input'],
  ] as const)('maps a glanceable snapshot with %i needs-input to %s', (needsInput, expected) => {
    expect(agentNotificationKindForPushData(glanceable(needsInput))).toBe(expected);
  });

  it.each([
    ['instance-lifecycle', { type: 'instance-lifecycle', event: 'ready', sandboxId: 'sb1' }],
    [
      'scheduled-action',
      { type: 'scheduled-action', event: 'scheduled_restart_notice', sandboxId: 'sb1' },
    ],
    ['low_balance', { type: 'low_balance', organizationId: 'org1' }],
    ['security_finding', { type: 'security_finding', findingId: 'f1', scope: 'org' }],
    [
      'security_lifecycle',
      { type: 'security_lifecycle', event: 'analysis_completed', findingId: 'f1', scope: 'org' },
    ],
  ] as const)('returns null for a %s feature push', (_label, payload) => {
    expect(agentNotificationKindForPushData(pushDataSchema.parse(payload))).toBeNull();
  });
});

describe('agentNotificationKindForGlanceableSnapshot', () => {
  it.each([
    [0, 'progress'],
    [3, 'needs-input'],
  ] as const)('maps needsInput %i to %s', (needsInput, expected) => {
    expect(agentNotificationKindForGlanceableSnapshot({ needsInput })).toBe(expected);
  });

  it('agrees with the push route for the same snapshot', () => {
    for (const needsInput of [0, 2]) {
      expect(agentNotificationKindForGlanceableSnapshot({ needsInput })).toBe(
        agentNotificationKindForPushData(glanceable(needsInput))
      );
    }
  });
});

describe('androidChannelIdForAgentKind', () => {
  it('routes needs-input to the needs-input channel', () => {
    expect(androidChannelIdForAgentKind('needs-input')).toBe('needs-input');
  });

  it('routes progress to the agent-progress channel', () => {
    expect(androidChannelIdForAgentKind('progress')).toBe('agent-progress');
  });
});

describe('agentNotificationKindForAndroidChannelId', () => {
  it('reads the kind back from the named agent channels', () => {
    expect(agentNotificationKindForAndroidChannelId('needs-input')).toBe('needs-input');
    expect(agentNotificationKindForAndroidChannelId('agent-progress')).toBe('progress');
  });

  it('is the inverse of androidChannelIdForAgentKind', () => {
    for (const kind of AGENT_NOTIFICATION_KINDS) {
      expect(agentNotificationKindForAndroidChannelId(androidChannelIdForAgentKind(kind))).toBe(
        kind
      );
    }
  });

  it('returns null for a non-agent channel or absent marker', () => {
    for (const channelId of ['kiloclaw', 'balance', 'security'] as const) {
      expect(agentNotificationKindForAndroidChannelId(channelId)).toBeNull();
    }
    expect(agentNotificationKindForAndroidChannelId(null)).toBeNull();
    expect(agentNotificationKindForAndroidChannelId(undefined)).toBeNull();
  });
});

describe('iosInterruptionLevelForPushData', () => {
  it('is time-sensitive for a needs-input push', () => {
    expect(
      iosInterruptionLevelForPushData(
        pushDataSchema.parse({
          type: 'cloud_agent_session',
          cliSessionId: 'cli1',
          category: 'attention',
        })
      )
    ).toBe('time-sensitive');
    expect(
      iosInterruptionLevelForPushData(
        pushDataSchema.parse({
          type: 'chat.message',
          sandboxId: 'sb1',
          conversationId: 'conv1',
          messageId: 'm1',
        })
      )
    ).toBe('time-sensitive');
    expect(iosInterruptionLevelForPushData(glanceable(2))).toBe('time-sensitive');
  });

  it('is active for a progress or non-agent push', () => {
    expect(
      iosInterruptionLevelForPushData(
        pushDataSchema.parse({ type: 'cloud_agent_session', cliSessionId: 'cli1' })
      )
    ).toBe('active');
    expect(iosInterruptionLevelForPushData(glanceable(0))).toBe('active');
    for (const [variant] of channelCases) {
      const parsed = pushDataSchema.parse(variant);
      if (agentNotificationKindForPushData(parsed) === 'needs-input') {
        continue;
      }
      expect(iosInterruptionLevelForPushData(parsed)).toBe('active');
    }
  });
});

describe('iosMutableContentForPushData', () => {
  it('is true for a visible progress agent push', () => {
    expect(
      iosMutableContentForPushData(
        pushDataSchema.parse({ type: 'cloud_agent_session', cliSessionId: 'cli1' })
      )
    ).toBe(true);
  });

  it('is false for the data-only glanceable carrier even when it is progress', () => {
    // No alert means no banner, so the extension has nothing to drop and the
    // wake must not be handed to it.
    expect(agentNotificationKindForPushData(glanceable(0))).toBe('progress');
    expect(iosMutableContentForPushData(glanceable(0))).toBe(false);
  });

  it('is false for needs-input and for non-agent pushes', () => {
    expect(
      iosMutableContentForPushData(
        pushDataSchema.parse({
          type: 'cloud_agent_session',
          cliSessionId: 'cli1',
          category: 'attention',
        })
      )
    ).toBe(false);
    expect(
      iosMutableContentForPushData(
        pushDataSchema.parse({
          type: 'chat.message',
          sandboxId: 'sb1',
          conversationId: 'conv1',
          messageId: 'm1',
        })
      )
    ).toBe(false);
    expect(iosMutableContentForPushData(glanceable(1))).toBe(false);
    for (const [variant] of channelCases) {
      const parsed = pushDataSchema.parse(variant);
      if (agentNotificationKindForPushData(parsed) === 'progress') {
        continue;
      }
      expect(iosMutableContentForPushData(parsed)).toBe(false);
    }
  });
});

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
    const attention = ANDROID_NOTIFICATION_CHANNELS.find(c => c.id === 'needs-input');
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

describe('androidChannelIdForPushDataToAppVersion', () => {
  const attention = {
    type: 'cloud_agent_session',
    cliSessionId: 'cli1',
    category: 'attention',
  } as const;
  const progress = { type: 'cloud_agent_session', cliSessionId: 'cli1' } as const;

  it('keeps an agent push on the legacy channel for a build that predates the split', () => {
    // 1.0.11 shipped before the split channels existed: its tokens have no
    // `needs-input`/`agent-progress`, so directing a push there would be
    // dropped on Android 8+. Only the split build and later may be addressed.
    expect(androidChannelIdForPushDataToAppVersion(attention, '1.0.11')).toBe(
      LEGACY_AGENT_ANDROID_CHANNEL_ID
    );
    expect(androidChannelIdForPushDataToAppVersion(attention, '1.0.10')).toBe(
      LEGACY_AGENT_ANDROID_CHANNEL_ID
    );
    expect(androidChannelIdForPushDataToAppVersion(progress, '1.0.11')).toBe(
      LEGACY_AGENT_ANDROID_CHANNEL_ID
    );
    expect(androidChannelIdForPushDataToAppVersion(progress, '1.0.4')).toBe(
      LEGACY_AGENT_ANDROID_CHANNEL_ID
    );
    expect(androidChannelIdForPushDataToAppVersion(progress, null)).toBeUndefined();
    expect(androidChannelIdForPushDataToAppVersion(progress, 'nightly')).toBe(
      LEGACY_AGENT_ANDROID_CHANNEL_ID
    );
  });

  it('reaches the split channels from the first build that creates them', () => {
    expect(
      androidChannelIdForPushDataToAppVersion(attention, AGENT_CHANNEL_SPLIT_APP_VERSION)
    ).toBe('needs-input');
    expect(androidChannelIdForPushDataToAppVersion(progress, '1.0.12')).toBe('agent-progress');
  });

  it('preserves pre-split chat and feature channels for an older build', () => {
    expect(
      androidChannelIdForPushDataToAppVersion(
        { type: 'chat.message', sandboxId: 'sb1', conversationId: 'conv1', messageId: 'm1' },
        '1.0.4'
      )
    ).toBe('chat');
    expect(
      androidChannelIdForPushDataToAppVersion(
        { type: 'low_balance', organizationId: 'org1' },
        '1.0.0'
      )
    ).toBe('balance');
  });

  it('shares the channel gate and preserves the legacy glanceable route', () => {
    expect(ANDROID_AGENT_KIND_CHANNELS_MIN_APP_VERSION).toBe(AGENT_CHANNEL_SPLIT_APP_VERSION);
    expect(androidChannelIdForPushDataToAppVersion(glanceable(2), '1.0.11')).toBe('active-agents');
    expect(androidChannelIdForPushDataToAppVersion(glanceable(2), '1.0.12')).toBe('needs-input');
    expect(androidChannelIdForPushDataToAppVersion(glanceable(0), '1.0.12')).toBe('agent-progress');
  });

  it('routes an agent push through its kind', () => {
    expect(
      androidChannelIdForPushData(
        pushDataSchema.parse({ type: 'cloud_agent_session', cliSessionId: 'cli1' })
      )
    ).toBe('agent-progress');
    expect(androidChannelIdForPushData(glanceable(2))).toBe('needs-input');
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

  it('returns the spend alert copy for the spend_alert variant', () => {
    const parsed = pushDataSchema.parse({
      type: 'spend_alert',
      scope: 'organization',
      organizationId: 'org1',
    });
    expect(androidChannelIdForPushData(parsed)).toBe('balance');
    expect(genericPushContentForPushData(parsed)).toEqual({
      title: 'Kilo',
      body: 'Your spend needs attention',
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

describe('androidChannelIdForRegisteredClient', () => {
  const splitVersion = ANDROID_AGENT_KIND_CHANNELS_MIN_APP_VERSION;

  it('hands a named agent channel to a client that creates it', () => {
    expect(androidChannelIdForRegisteredClient('needs-input', splitVersion)).toBe('needs-input');
    expect(androidChannelIdForRegisteredClient('agent-progress', '1.0.12')).toBe('agent-progress');
    expect(androidChannelIdForRegisteredClient('agent-progress', '1.10.0')).toBe('agent-progress');
  });

  it('withholds a named agent channel from a pre-split or unknown client', () => {
    // Both older clients know only the legacy channels, and this build deletes
    // those, so naming a channel would make Android drop the post.
    expect(androidChannelIdForRegisteredClient('needs-input', '1.0.10')).toBeUndefined();
    expect(androidChannelIdForRegisteredClient('needs-input', '1.0.11')).toBeUndefined();
    expect(androidChannelIdForRegisteredClient('agent-progress', '1.0.11')).toBeUndefined();
    expect(androidChannelIdForRegisteredClient('needs-input', null)).toBeUndefined();
    expect(androidChannelIdForRegisteredClient('needs-input', undefined)).toBeUndefined();
    expect(androidChannelIdForRegisteredClient('agent-progress', 'not-a-version')).toBeUndefined();
  });

  it('keeps the pre-split channels for every client that created them', () => {
    for (const channelId of ['kiloclaw', 'balance', 'security'] as const) {
      expect(androidChannelIdForRegisteredClient(channelId, '1.0.4')).toBe(channelId);
      expect(androidChannelIdForRegisteredClient(channelId, splitVersion)).toBe(channelId);
      expect(androidChannelIdForRegisteredClient(channelId, null)).toBeUndefined();
    }
  });
});
