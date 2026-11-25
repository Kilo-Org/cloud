import { runInDurableObject } from 'cloudflare:test';

const AUDIT_TABLES = ['audit_event', 'audit_watermark', 'audit_prune'];

/**
 * Durable Object storage in this pool's worker is shared by every test in a file, so each test
 * starts from an empty object: the tables are cleared, the alarm removed, and the instance
 * aborted so in-memory caches (keys, the manager token) start empty too. Only test code
 * touches SQL directly.
 */
async function resetObject(stub: DurableObjectStub, tables: string[]): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    for (const table of [...tables, ...AUDIT_TABLES]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
    state.storage.sql.exec(`DELETE FROM sqlite_sequence WHERE name = 'audit_event'`);
    await state.storage.deleteAlarm();
  });
  await runInDurableObject(stub, (_instance, state) => state.abort('test reset')).catch(
    () => undefined
  );
}

export async function resetBundleObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, ['bundle', 'bundle_key', 'delivery_counter']);
}

/** The webhook secret is kept: tests read it from storage when they sign a webhook. */
export async function resetRefresherObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, ['manager_folder', 'refresher_key', 'policy_state', 'refresher_state']);
}

export async function resetDenialObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, ['denial_window']);
}
