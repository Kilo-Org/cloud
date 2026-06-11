import { afterEach, describe, expect, it } from 'vitest';
import { clearRoutingTableCache, DEFAULT_ROUTING_TABLE, getRoutingTable } from './routing-table';

type KvStub = Pick<Env, 'AUTO_ROUTING_CONFIG'>;
const kvEnv = (value: string | null, onGet?: () => void): KvStub =>
  ({
    AUTO_ROUTING_CONFIG: {
      get: async () => {
        onGet?.();
        return value;
      },
    },
  }) as unknown as KvStub;

afterEach(() => clearRoutingTableCache());

describe('getRoutingTable', () => {
  it('returns the default table when the key is missing', async () => {
    expect(await getRoutingTable(kvEnv(null))).toEqual(DEFAULT_ROUTING_TABLE);
  });
  it('returns the default table when the stored JSON is invalid', async () => {
    expect(await getRoutingTable(kvEnv('{"nope":true}'))).toEqual(DEFAULT_ROUTING_TABLE);
    clearRoutingTableCache();
    expect(await getRoutingTable(kvEnv('not json at all'))).toEqual(DEFAULT_ROUTING_TABLE);
  });
  it('parses and caches a valid stored table', async () => {
    let reads = 0;
    const env = kvEnv(JSON.stringify(DEFAULT_ROUTING_TABLE), () => reads++);
    const first = await getRoutingTable(env);
    await getRoutingTable(env);
    expect(first.version).toBe(DEFAULT_ROUTING_TABLE.version);
    expect(reads).toBe(1);
  });
});
