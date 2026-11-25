import { runInDurableObject } from 'cloudflare:test';
import type { BundleDO } from '../../src/dos/BundleDO';
import type { RefresherDO } from '../../src/dos/RefresherDO';

/**
 * Durable Object storage in this pool's worker is shared by every test in a file,
 * so each test starts from an empty object. Only test code touches SQL directly.
 */
export async function resetBundleObject(stub: DurableObjectStub<BundleDO>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    for (const table of [
      'bundle',
      'bundle_key',
      'delivery_counter',
      'audit_event',
      'audit_watermark',
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
    state.storage.sql.exec(`DELETE FROM sqlite_sequence WHERE name = 'audit_event'`);
    await state.storage.deleteAlarm();
  });
}

export async function resetRefresherObject(stub: DurableObjectStub<RefresherDO>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    for (const table of [
      'manager_snapshot',
      'refresher_key',
      'policy_state',
      'refresher_state',
      'audit_event',
      'audit_watermark',
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
    state.storage.sql.exec(`DELETE FROM sqlite_sequence WHERE name = 'audit_event'`);
    await state.storage.deleteAlarm();
  });
}
