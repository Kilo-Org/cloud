import { describe, expect, it } from 'vitest';
import { AUTO_ROUTERS, AutoRouterSchema, DEFAULT_AUTO_ROUTER } from './router';
import {
  FRONTIER_ROUTING_TABLE_KV_KEY,
  ROUTING_TABLE_KV_KEY,
  routingTableKvKey,
} from './routing-table';

describe('auto router identities', () => {
  it('retains efficient as the default and its existing table key', () => {
    expect(DEFAULT_AUTO_ROUTER).toBe('efficient');
    expect(routingTableKvKey()).toBe('routing_table_v1');
    expect(routingTableKvKey('efficient')).toBe(ROUTING_TABLE_KV_KEY);
  });

  it('uses an independent frontier table key', () => {
    expect(routingTableKvKey('frontier')).toBe(FRONTIER_ROUTING_TABLE_KV_KEY);
    expect(FRONTIER_ROUTING_TABLE_KV_KEY).toBe('routing_table_frontier_v1');
    expect(FRONTIER_ROUTING_TABLE_KV_KEY).not.toBe(ROUTING_TABLE_KV_KEY);
  });

  it('validates supported routers and rejects unknown identities', () => {
    for (const router of AUTO_ROUTERS) expect(AutoRouterSchema.parse(router)).toBe(router);
    expect(AutoRouterSchema.safeParse('unknown').success).toBe(false);
  });
});
