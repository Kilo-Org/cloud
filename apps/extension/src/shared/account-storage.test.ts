import { describe, expect, it } from 'vitest';
import { clearAccountStorage } from './account-storage';
import type { AccountStorageArea } from './account-storage';

/* Mirrors WXT storage: `snapshot('local')` returns unprefixed keys, `removeItems` takes `local:` keys. */
const createLocalStorage = (
  initial: Record<string, unknown>
): { readonly local: Map<string, unknown>; readonly storage: AccountStorageArea } => {
  const local = new Map(Object.entries(initial));

  return {
    local,
    storage: {
      removeItems: keys => {
        for (const key of keys) {
          local.delete(key.slice('local:'.length));
        }
      },
      snapshot: base => {
        expect(base).toBe('local');
        return Object.fromEntries(local);
      },
    },
  };
};

describe('account storage on sign-out', () => {
  it('removes account data and keeps the local-agents switch and pairing', async () => {
    const endpoints = { endpoints: [{ hubId: 'hub', key: 'key', ws: 'ws://127.0.0.1:1' }] };
    const { local, storage } = createLocalStorage({
      analyticsLastActiveDay: '2026-11-19:marker',
      kiloAgentConversation: { events: [] },
      kiloAgentConversations: { conversations: [] },
      kiloAgentDrafts: {},
      kiloAgentMemories: [],
      kiloAgentWorkflows: [],
      kiloAuth: { token: 'token-1', userEmail: 'user@kilo.ai' },
      kiloLocalAgentEndpoints: endpoints,
      kiloLocalAgentSettings: { enabled: true },
      kiloMemorySettings: { autoApprove: true },
      kiloPendingAgentMemoryDraft: { content: 'draft' },
      kiloPendingWorkflowSave: { name: 'draft' },
      kiloRemoteMcpServers: { servers: [] },
      kiloSelectedOrganizationId: 'org-1',
      kiloSidePanelMode: 'agents',
      kiloWebMcpSettings: { enabled: true },
      kiloWorkflowSettings: { autoApproveChanges: true },
      laterAccountKey: 'unlisted keys count as account data',
    });

    await clearAccountStorage(storage);

    expect(Object.fromEntries(local)).toStrictEqual({
      kiloLocalAgentEndpoints: endpoints,
      kiloLocalAgentSettings: { enabled: true },
    });
  });
});
