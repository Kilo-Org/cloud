import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSecretCacheForTest } from '@kilocode/worker-utils';
import {
  BLACKLISTED_DOMAINS_REDIS_KEY,
  BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY,
  MAX_BLACKLIST_DOMAINS,
} from '@kilocode/worker-utils/account-access';
import { clearOrganizationPolicyCache, getBlacklistedDomains } from './organization-policy';

const env = {
  UPSTASH_REDIS_REST_URL: { get: async () => 'https://redis.example.test' },
  UPSTASH_REDIS_REST_TOKEN: { get: async () => 'redis-read-token' },
} as unknown as Env;

function storedDomains(extra: number): string[] {
  return Array.from({ length: MAX_BLACKLIST_DOMAINS + extra }, (_, i) => `host${i}.test`);
}

function stubRedis(store: Map<string, string>): void {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : '[]';
    const [command, key] = JSON.parse(body) as [string, string];
    const result = command === 'GET' ? (store.get(key) ?? null) : null;
    return { ok: true, json: async () => ({ result }) } as Response;
  });
}

function storeFor(config: unknown, updatedAt: string): Map<string, string> {
  return new Map([
    [BLACKLISTED_DOMAINS_REDIS_KEY, JSON.stringify(config)],
    [BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY, updatedAt],
  ]);
}

describe('getBlacklistedDomains', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearOrganizationPolicyCache();
    clearSecretCacheForTest();
  });

  it('enforces the stored prefix and names the entries beyond it once per loaded config', async () => {
    const domains = storedDomains(3);
    stubRedis(
      storeFor(
        {
          domains,
          blocked_signup_tlds: [],
          updated_at: 't1',
          updated_by: null,
          updated_by_email: null,
        },
        't1'
      )
    );
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await getBlacklistedDomains(env)).toEqual(domains.slice(0, MAX_BLACKLIST_DOMAINS));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      event: 'auto_routing_blacklist_domains_over_cap',
      droppedDomains: 3,
    });

    // A later refresh of the same config keeps one line for that config.
    vi.setSystemTime(11 * 60_000);
    expect(await getBlacklistedDomains(env)).toHaveLength(MAX_BLACKLIST_DOMAINS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
