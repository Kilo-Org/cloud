import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_HISTORY_CATEGORIES,
  RECORDED_NOTIFICATION_PUSH_TYPES,
  notificationHistoryEntryForPushData,
} from './notification-history';
import { pushDataSchema, type PushData } from './push-data';

/** Every kind the push schema can carry, read from the schema itself. */
const ALL_PUSH_KINDS = pushDataSchema.options.map(option => option.shape.type.value);

describe('notificationHistoryEntryForPushData', () => {
  it('records the message kinds and leaves every OS-only surface out', () => {
    const unrecorded = ALL_PUSH_KINDS.filter(
      kind => !(RECORDED_NOTIFICATION_PUSH_TYPES as readonly string[]).includes(kind)
    );

    // Exactly the surfaces with nothing to reopen from a list: the aggregate
    // glanceable, the followed-session live update, and the two lifecycle
    // kinds of an end-of-life product.
    expect(unrecorded.sort()).toEqual([
      'active_agents_glanceable',
      'instance-lifecycle',
      'scheduled-action',
      'session_live_update',
    ]);
  });

  it('maps each recorded kind to its settings category', () => {
    const cases: { data: PushData; category: string | null }[] = [
      {
        data: {
          type: 'chat.message',
          sandboxId: 'sb',
          conversationId: 'conv',
          messageId: 'msg',
        },
        category: 'chatMessages',
      },
      {
        data: { type: 'cloud_agent_session', cliSessionId: 'session', category: 'attention' },
        category: 'agentAttention',
      },
      {
        data: { type: 'cloud_agent_session', cliSessionId: 'session', category: 'status' },
        category: 'sessionStatus',
      },
      // An omitted tag is a status push: the rolling-deploy default the
      // dispatch gate applies.
      { data: { type: 'cloud_agent_session', cliSessionId: 'session' }, category: 'sessionStatus' },
      { data: { type: 'low_balance', organizationId: 'org' }, category: 'balanceAlerts' },
      { data: { type: 'spend_alert', scope: 'personal' }, category: 'spendAlerts' },
      {
        data: { type: 'security_finding', findingId: 'finding', scope: 'personal' },
        category: 'securityFindings',
      },
      {
        data: {
          type: 'security_lifecycle',
          event: 'remediation_queued',
          findingId: 'finding',
          scope: 'personal',
        },
        category: 'securityFindings',
      },
      // Briefings have no settings category; they appear under All only.
      { data: { type: 'agent_briefing', url: '/agent-briefing' }, category: null },
    ];

    for (const { data, category } of cases) {
      const entry = notificationHistoryEntryForPushData(data);
      expect(entry).toEqual({ pushType: data.type, category });
      if (entry?.category !== null && entry !== null) {
        expect(NOTIFICATION_HISTORY_CATEGORIES).toContain(entry.category);
      }
    }
  });

  it('returns null for every unrecorded kind', () => {
    for (const kind of ALL_PUSH_KINDS) {
      if ((RECORDED_NOTIFICATION_PUSH_TYPES as readonly string[]).includes(kind)) continue;
      // The resolver only reads `type` (and `category` on a session push), so a
      // discriminator-only sample is enough to prove the gate.
      expect(notificationHistoryEntryForPushData({ type: kind } as PushData)).toBeNull();
    }
  });
});
