import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  applyAgentPushOptimistic,
  DEFAULT_NOTIFICATION_PREFERENCE,
  deriveAgentPushEditable,
  deriveShowEnableCta,
  NOTIFICATION_CATEGORY_KEYS,
  type NotificationCategoryKey,
  type NotificationPreferences,
  readAgentPushPreference,
  rollbackAgentPushOptimistic,
} from './agent-push-preference';

const key = ['user', 'getNotificationPreferences'] as const;

function makeQueryClient(): QueryClient {
  return new QueryClient();
}

function readRow(qc: QueryClient): NotificationPreferences {
  const data = qc.getQueryData(key);
  if (!data) {
    throw new Error('expected query data to be present');
  }
  return data as NotificationPreferences;
}

function fullRow(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    chatMessages: DEFAULT_NOTIFICATION_PREFERENCE,
    agentAttention: DEFAULT_NOTIFICATION_PREFERENCE,
    agentUpdates: DEFAULT_NOTIFICATION_PREFERENCE,
    sessionStatus: DEFAULT_NOTIFICATION_PREFERENCE,
    kiloclawActivity: DEFAULT_NOTIFICATION_PREFERENCE,
    agentPushEnabled: DEFAULT_NOTIFICATION_PREFERENCE,
    ...overrides,
  };
}

describe('DEFAULT_NOTIFICATION_PREFERENCE', () => {
  it('is true (default ON per plan)', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCE).toBe(true);
  });
});

describe('NOTIFICATION_CATEGORY_KEYS', () => {
  it('lists the 5 categories rendered on the dedicated screen', () => {
    expect([...NOTIFICATION_CATEGORY_KEYS]).toEqual([
      'chatMessages',
      'agentAttention',
      'agentUpdates',
      'sessionStatus',
      'kiloclawActivity',
    ]);
  });
});

describe('deriveAgentPushEditable', () => {
  it('is true when the preference query has data and no mutation is pending', () => {
    expect(deriveAgentPushEditable({ hasData: true, isPending: false })).toBe(true);
  });

  it('is false while a mutation is pending even if the query has data', () => {
    expect(deriveAgentPushEditable({ hasData: true, isPending: true })).toBe(false);
  });

  it('is false when the preference query has not loaded', () => {
    expect(deriveAgentPushEditable({ hasData: false, isPending: false })).toBe(false);
  });

  it('is false while a mutation is pending without loaded data', () => {
    expect(deriveAgentPushEditable({ hasData: false, isPending: true })).toBe(false);
  });
});

describe('deriveShowEnableCta (empty-state CTA presence)', () => {
  it('shows the CTA when notifications are disabled (permission not granted OR no backend token)', () => {
    expect(deriveShowEnableCta(false)).toBe(true);
  });

  it('hides the CTA when notifications are fully enabled', () => {
    expect(deriveShowEnableCta(true)).toBe(false);
  });
});

describe('readAgentPushPreference', () => {
  it('returns the default for the requested category when the cache has no snapshot', () => {
    const qc = makeQueryClient();
    for (const category of NOTIFICATION_CATEGORY_KEYS) {
      expect(readAgentPushPreference(qc, key, category)).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
    }
  });

  it('returns the cached value for each category when the full row is present', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, {
      chatMessages: true,
      agentAttention: false,
      agentUpdates: true,
      sessionStatus: false,
      kiloclawActivity: true,
      agentPushEnabled: true,
    });
    expect(readAgentPushPreference(qc, key, 'chatMessages')).toBe(true);
    expect(readAgentPushPreference(qc, key, 'agentAttention')).toBe(false);
    expect(readAgentPushPreference(qc, key, 'agentUpdates')).toBe(true);
    expect(readAgentPushPreference(qc, key, 'sessionStatus')).toBe(false);
    expect(readAgentPushPreference(qc, key, 'kiloclawActivity')).toBe(true);
  });

  it('maps the legacy `agentPushEnabled` snapshot to the agentUpdates category', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, { agentPushEnabled: false });
    expect(readAgentPushPreference(qc, key, 'agentUpdates')).toBe(false);
    // Non-agentUpdates categories fall back to the default when only the
    // legacy field is present.
    expect(readAgentPushPreference(qc, key, 'chatMessages')).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
  });

  it('defaults to the agentUpdates category when no category is passed', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, fullRow({ agentUpdates: false }));
    expect(readAgentPushPreference(qc, key)).toBe(false);
  });
});

describe('applyAgentPushOptimistic + rollbackAgentPushOptimistic (per-category)', () => {
  it('flips the requested category and leaves the others unchanged', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, fullRow({ agentAttention: true, sessionStatus: true }));

    const context = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
      category: 'agentAttention',
    });

    const after = readRow(qc);
    expect(after.agentAttention).toBe(false);
    expect(after.sessionStatus).toBe(true);
    expect(after.agentUpdates).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
    expect(context.previous).toEqual(fullRow({ agentAttention: true, sessionStatus: true }));
    expect(context.previousWasLegacy).toBe(false);
  });

  it('flips a non-agentUpdates category in a real 6-key snapshot without corrupting the other keys', async () => {
    const qc = makeQueryClient();
    const original = {
      chatMessages: true,
      agentAttention: true,
      agentUpdates: true,
      sessionStatus: false,
      kiloclawActivity: true,
      agentPushEnabled: true,
    } as const satisfies NotificationPreferences;
    qc.setQueryData(key, original);

    const context = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: true,
      category: 'sessionStatus',
    });

    const after = readRow(qc);
    expect(after.sessionStatus).toBe(true);
    expect(after.chatMessages).toBe(true);
    expect(after.agentAttention).toBe(true);
    expect(after.agentUpdates).toBe(true);
    expect(after.kiloclawActivity).toBe(true);
    expect(after.agentPushEnabled).toBe(true);

    expect(context.previous).toEqual(original);
    expect(context.previousWasLegacy).toBe(false);

    rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context });
    expect(qc.getQueryData(key)).toEqual(original);
  });

  it('rolls back to the previous snapshot on error', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, fullRow({ agentAttention: true }));

    const context = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
      category: 'agentAttention',
    });
    expect(readRow(qc).agentAttention).toBe(false);

    rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context });
    expect(qc.getQueryData(key)).toEqual(fullRow({ agentAttention: true }));
  });

  it('rolls back from a default-ON starting state (no prior cache entry)', async () => {
    const qc = makeQueryClient();
    expect(qc.getQueryData(key)).toBeUndefined();

    const context = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
      category: 'agentUpdates',
    });
    // No prior cache entry => previous is undefined; the optimistic write
    // materializes the full row with the flipped value so the row reads
    // consistently while the mutation is in flight.
    expect(context.previous).toBeUndefined();
    expect(readRow(qc).agentUpdates).toBe(false);

    rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context });
    // No prior snapshot => cache restored to the absent state, not a fabricated true.
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  it('rolls back each category independently and removes the empty-cache entry', async () => {
    await Promise.all(
      NOTIFICATION_CATEGORY_KEYS.map(async category => {
        const qc = makeQueryClient();
        const context = await applyAgentPushOptimistic({
          queryClient: qc,
          queryKey: key,
          next: false,
          category,
        });
        expect(readRow(qc)[category]).toBe(false);
        rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context });
        expect(qc.getQueryData(key)).toBeUndefined();
      })
    );
  });

  it('preserves the legacy `agentPushEnabled`-only snapshot exactly on rollback', async () => {
    const qc = makeQueryClient();
    const legacy = { agentPushEnabled: true } as const;
    qc.setQueryData(key, legacy);

    const context = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
      category: 'agentAttention',
    });
    // After applying, the cache holds the promoted per-category shape with
    // agentAttention flipped to false and agentUpdates carrying the legacy
    // value (true).
    const after = readRow(qc);
    expect(after.agentAttention).toBe(false);
    expect(after.agentUpdates).toBe(true);
    expect(context.previous).toBe(legacy);
    expect(context.previousWasLegacy).toBe(true);

    rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context });
    // Rollback must restore the exact legacy shape, not the promoted one.
    expect(qc.getQueryData(key)).toEqual(legacy);
  });

  it('treats an undefined context as a no-op rollback (defensive against missing context)', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, fullRow({ agentAttention: true }));
    expect(() => {
      rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context: undefined });
    }).not.toThrow();
    // The cache is left intact when no context is provided.
    expect(qc.getQueryData(key)).toEqual(fullRow({ agentAttention: true }));
  });
});

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
      const qc = makeQueryClient();
      qc.setQueryData(key, fullRow());

      const context = await applyAgentPushOptimistic({
        queryClient: qc,
        queryKey: key,
        next,
        category,
      });
      const after = readRow(qc);
      expect(after[category]).toBe(next);
      for (const other of NOTIFICATION_CATEGORY_KEYS) {
        if (other !== category) {
          expect(after[other]).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
        }
      }

      rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, context });
      expect(qc.getQueryData(key)).toEqual(fullRow());
    });
  }
});
