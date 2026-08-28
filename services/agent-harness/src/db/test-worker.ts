import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import type { EventEnvelope } from '@kilocode/agent-harness/contracts';
import type { CommandReply } from '@kilocode/agent-harness/journal';
import migrations from '../../drizzle/migrations.js';
import { openStore, type ConversationStore } from './store';

export class TestStore extends DurableObject<unknown> {
  private initialized: ConversationStore | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.initialized = await openStore(ctx);
    });
  }

  get store() {
    if (!this.initialized) throw new Error('Store initialization has not finished');
    return this.initialized;
  }

  commit(
    options: Parameters<ConversationStore['transition']>[0],
    events: EventEnvelope['event'][],
    reply?: CommandReply
  ) {
    return this.store.transition(options, () => ({ events, reply }));
  }

  // Test-only progress marker. This is not the production scheduler or alarm handler.
  async alarm() {
    if (this.store.snapshot()?.activeRun) return;
    const queued = this.store.queuedRuns(0, 1)[0];
    if (queued)
      await this.store.transition({ wakeAt: null }, () => ({
        events: [{ type: 'run', run: { ...queued.data, state: { status: 'completed' } } }],
      }));
  }
}

export class OldTestStore extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() =>
      migrate(drizzle(ctx.storage), {
        ...migrations,
        journal: { ...migrations.journal, entries: migrations.journal.entries.slice(0, 1) },
      })
    );
  }
}

export const getTestStoreStub = (
  namespace: DurableObjectNamespace<TestStore>,
  name: string | DurableObjectId
) => (typeof name === 'string' ? namespace.getByName(name) : namespace.get(name));
export const getOldTestStoreStub = (
  namespace: DurableObjectNamespace<OldTestStore>,
  name: string
) => namespace.getByName(name);

export default {} satisfies ExportedHandler;
