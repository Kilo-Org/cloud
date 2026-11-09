import { Redis } from '@upstash/redis';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { backfillDomainBlacklist } from '@kilocode/web-shared/lib/blacklist-domains-migration';
import {
  BLACKLISTED_DOMAINS_REDIS_KEY,
  BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
} from '@kilocode/worker-utils/account-access';

export async function run(...args: string[]): Promise<void> {
  if (!args.includes('--apply') || !args.includes('--admins-frozen')) {
    throw new Error('Requires authorized --apply --admins-frozen; no Redis data has been read');
  }
  const redis = Redis.fromEnv({
    automaticDeserialization: false,
    retry: false,
    signal: () => AbortSignal.timeout(30_000),
  });
  await backfillDomainBlacklist(
    db,
    () => redis.get<string>(BLACKLISTED_DOMAINS_REDIS_KEY),
    settings => redis.set(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(settings))
  );
  console.log('Domain blacklist backfill committed. The legacy Redis snapshot is unchanged.');
}
