import { errorFields, runMaintenance, step } from './audit/maintenance';
import { AUDIT_SHARD_COUNT } from './audit/relay';
import { withIdentityStore } from './db/client';
import { getAuditRelayStub } from './dos/stubs';
import { readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';

/** Arms each shard's relay object; logs `uts.audit_relay.not_started` for one that failed or refused. */
export async function startRelays(env: Env, config: UtsConfig): Promise<void> {
  const shards = Array.from({ length: AUDIT_SHARD_COUNT }, (_, shard) => shard);
  const results = await Promise.allSettled(
    shards.map(shard => getAuditRelayStub(env, config, shard).ensureStarted())
  );
  results.forEach((result, shard) => {
    if (result.status === 'rejected' || !result.value) {
      console.error(
        JSON.stringify({
          event: 'uts.audit_relay.not_started',
          shard,
          ...(result.status === 'rejected' ? errorFields(result.reason) : { error: 'refused' }),
        })
      );
    }
  });
}

/**
 * The minute cron: keeps the 8 shard relays running, maintains audit partitions and OAuth rows,
 * and raises the relay-lag alert (`src/audit/maintenance.ts`). Nothing runs until the environment
 * binds its identity store. Every statement is its own transaction on one connection.
 */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  context: ExecutionContext
): Promise<void> {
  const config = readConfig(env);
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return;
  await startRelays(env, config);
  await step('connect', () =>
    withIdentityStore(binding.connectionString, context, store => runMaintenance(store))
  );
}
