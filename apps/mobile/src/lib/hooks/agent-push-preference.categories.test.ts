import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  applyAgentPushOptimistic,
  DEFAULT_NOTIFICATION_PREFERENCE,
  NOTIFICATION_CATEGORY_KEYS,
  type NotificationCategoryKey,
  type NotificationPreferences,
  rollbackAgentPushOptimistic,
} from './agent-push-preference';

const key = ['user', 'getNotificationPreferences'] as const;

function fullRow(): NotificationPreferences {
  return {
    chatMessages: DEFAULT_NOTIFICATION_PREFERENCE,
    agentAttention: DEFAULT_NOTIFICATION_PREFERENCE,
    agentUpdates: DEFAULT_NOTIFICATION_PREFERENCE,
    sessionStatus: DEFAULT_NOTIFICATION_PREFERENCE,
    kiloclawActivity: DEFAULT_NOTIFICATION_PREFERENCE,
    agentPushEnabled: DEFAULT_NOTIFICATION_PREFERENCE,
  };
}

describe('per-category flip flow (each category in turn)', () => {
  const scenarios: { category: NotificationCategoryKey; next: boolean }[] = [
    { category: 'chatMessages', next: false },
    { category: 'agentAttention', next: true },
    { category: 'agentUpdates', next: false },
    { category: 'sessionStatus', next: true },
    { category: 'kiloclawActivity', next: false },
  ];

  for (const { category, next } of scenarios) {
    it(`flips only ${category} → ${next} and rolls back cleanly`, async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(key, fullRow());

      const context = await applyAgentPushOptimistic({
        queryClient,
        queryKey: key,
        next,
        category,
      });
      const after = queryClient.getQueryData<NotificationPreferences>(key);
      expect(after?.[category]).toBe(next);
      for (const other of NOTIFICATION_CATEGORY_KEYS) {
        if (other !== category) {
          expect(after?.[other]).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
        }
      }

      rollbackAgentPushOptimistic({ queryClient, queryKey: key, context });
      expect(queryClient.getQueryData(key)).toEqual(fullRow());
    });
  }
});
