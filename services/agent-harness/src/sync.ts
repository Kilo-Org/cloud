import type { QuickChatAuthority } from '../../../packages/db/src/quick-chat-runtime';
import type { ConversationStore } from './db/store';
import { createLegacyCoordinator, type LegacyAdapter } from './legacy';
import { fail } from './limits';

// Bind this coordinator to authenticated primary authority, never a caller-selected owner or context.
// Production transport and alarm composition belong to the owning Durable Object.
export function createSynchronization(
  store: ConversationStore,
  authority: QuickChatAuthority,
  adapter: LegacyAdapter,
  now: () => number = Date.now
) {
  const legacy = createLegacyCoordinator(store, authority, adapter, now);
  async function prepareRead() {
    await legacy.authorize('read');
    // One request drains at most one batch. The primary pending rows also remain available to cron.
    await legacy.drainLegacy();
    await legacy.authorize('read');
  }
  return {
    store: legacy.store,
    importLegacy: legacy.importLegacy,
    drainLegacy: legacy.drainLegacy,
    drainProjections: legacy.drainProjections,
    async snapshot() {
      await prepareRead();
      // The store reads content, settings, all unresolved work, and the event cursor in one transaction.
      const snapshot = store.snapshot();
      if (!snapshot) fail('access_revoked', 'The conversation is no longer available.');
      return snapshot;
    },
    async history(before: string | null = null, limit = 50) {
      await prepareRead();
      return store.history(before, limit);
    },
    async eventsAfter(after: number, limit = 200) {
      await prepareRead();
      // Preserve the portable cursor_expired result. Recovery replaces state with a fresh snapshot,
      // then resumes exclusively after its cursor; no in-memory connection sequence is authoritative.
      return store.eventsAfter(after, limit);
    },
  };
}
