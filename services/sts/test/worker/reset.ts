import { runInDurableObject } from 'cloudflare:test';

const AUDIT_TABLES = ['audit_event', 'audit_watermark', 'audit_prune'];

/**
 * Durable Object storage in this pool's worker is shared by every test in a file, so each test
 * starts from an empty object: the tables are cleared, the alarm removed, and the instance
 * aborted so in-memory caches (keys, the manager token) start empty too. Only test code
 * touches SQL directly.
 */
async function resetObject(
  stub: DurableObjectStub,
  tables: string[],
  keys: string[] = []
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    if (keys.length > 0) await state.storage.delete(keys);
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
  await resetObject(stub, ['bundle', 'delivery_counter'], ['bundle-keys']);
}

/** The webhook secret is kept: tests read it from storage when they sign a webhook. */
export async function resetRefresherObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(
    stub,
    ['manager_folder', 'policy_state', 'refresher_state'],
    ['refresher-seal-key']
  );
}

export async function resetDenialObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, ['denial_window']);
}

/** The key ring goes too, so each test starts from a signer that has never generated a key. */
export async function resetTokenSignerObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, [], ['token-key-ring']);
}

/** The aborted instance also forgets its manager access token. */
export async function resetLeaseObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, ['lease', 'lease_replica_sweep']);
}

/** The aborted instance also forgets its minting credential and manager access token. */
export async function resetDeployTokenObject(stub: DurableObjectStub): Promise<void> {
  await resetObject(stub, [
    'deploy_token',
    'deploy_token_sweep',
    'deploy_token_sweep_retry',
    'deploy_token_credential_hold',
    'deploy_token_route_zone',
    'deploy_token_route',
  ]);
}
