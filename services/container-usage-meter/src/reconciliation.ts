import { FAILOVER_BUFFER_SHARD_COUNT, failoverBufferShardNameForIndex } from './sharding';

export const CONTAINER_USAGE_RECONCILIATION_CRON = '*/5 * * * *';

export async function runReconciliationScaffold(env: Cloudflare.Env): Promise<void> {
  const backlogs = await Promise.all(
    Array.from({ length: FAILOVER_BUFFER_SHARD_COUNT }, (_, index) =>
      env.FAILOVER_BUFFER.getByName(failoverBufferShardNameForIndex(index)).getBacklog()
    )
  );
  const backlog = {
    count: backlogs.reduce((total, shard) => total + shard.count, 0),
    oldestReceivedAtMs: backlogs.reduce<number | undefined>((oldest, shard) => {
      if (shard.oldestReceivedAtMs === undefined) return oldest;
      return oldest === undefined
        ? shard.oldestReceivedAtMs
        : Math.min(oldest, shard.oldestReceivedAtMs);
    }, undefined),
  };
  console.log(
    JSON.stringify({
      message: 'Container usage reconciliation scaffold completed',
      event: 'reconciliation_scaffold',
      ...backlog,
    })
  );
}
