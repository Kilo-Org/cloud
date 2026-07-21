export const FAILOVER_BUFFER_SHARD_COUNT = 1;

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function failoverBufferShardName(service: string, instanceId: string): string {
  return failoverBufferShardNameForIndex(
    stableHash(`${service}:${instanceId}`) % FAILOVER_BUFFER_SHARD_COUNT
  );
}

export function failoverBufferShardNameForIndex(index: number): string {
  return `container-usage-failover-${index}`;
}
