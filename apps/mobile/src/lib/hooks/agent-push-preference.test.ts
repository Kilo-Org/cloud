import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  applyAgentPushOptimistic,
  DEFAULT_AGENT_PUSH_ENABLED,
  deriveAgentPushEditable,
  readAgentPushPreference,
  rollbackAgentPushOptimistic,
} from './agent-push-preference';

const key = ['user', 'getNotificationPreferences'] as const;

function makeQueryClient(): QueryClient {
  return new QueryClient();
}

describe('DEFAULT_AGENT_PUSH_ENABLED', () => {
  it('is true (default ON per plan §4.5)', () => {
    expect(DEFAULT_AGENT_PUSH_ENABLED).toBe(true);
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

describe('readAgentPushPreference', () => {
  it('returns the default when the cache has no snapshot', () => {
    const qc = makeQueryClient();
    expect(readAgentPushPreference(qc, key)).toBe(DEFAULT_AGENT_PUSH_ENABLED);
  });

  it('returns the cached value when present (true)', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, { agentPushEnabled: true });
    expect(readAgentPushPreference(qc, key)).toBe(true);
  });

  it('returns the cached value when present (false)', () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, { agentPushEnabled: false });
    expect(readAgentPushPreference(qc, key)).toBe(false);
  });
});

describe('applyAgentPushOptimistic + rollbackAgentPushOptimistic', () => {
  it('writes the new value and returns the previous snapshot for rollback', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, { agentPushEnabled: true });

    const { previous } = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
    });

    expect(previous).toEqual({ agentPushEnabled: true });
    expect(qc.getQueryData(key)).toEqual({ agentPushEnabled: false });
  });

  it('rolls back to the previous snapshot on error', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(key, { agentPushEnabled: true });

    const { previous } = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
    });
    expect(qc.getQueryData(key)).toEqual({ agentPushEnabled: false });

    rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, previous });
    expect(qc.getQueryData(key)).toEqual({ agentPushEnabled: true });
  });

  it('rolls back from a default-ON starting state (no prior cache entry)', async () => {
    const qc = makeQueryClient();
    expect(qc.getQueryData(key)).toBeUndefined();

    const { previous } = await applyAgentPushOptimistic({
      queryClient: qc,
      queryKey: key,
      next: false,
    });
    expect(previous).toBeUndefined();
    expect(qc.getQueryData(key)).toEqual({ agentPushEnabled: false });

    rollbackAgentPushOptimistic({ queryClient: qc, queryKey: key, previous });
    // No prior snapshot => cache restored to the absent state, not a fabricated true.
    expect(qc.getQueryData(key)).toBeUndefined();
  });
});
