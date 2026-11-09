import type { DrizzleClient } from '@kilocode/db/client';
import { blacklisted_domains, domain_blacklist_state } from '@kilocode/db/schema';
import {
  BlacklistDomainsConfigSchema,
  type BlacklistDomainsConfig,
} from '@kilocode/worker-utils/account-access';
import { eq, sql } from 'drizzle-orm';

const LegacySettingsSchema = BlacklistDomainsConfigSchema.omit({ domains: true });

export async function initializeDomainBlacklist(
  db: DrizzleClient['db'],
  readLegacy: () => Promise<string | null>,
  writeSettings: (settings: BlacklistDomainsConfig) => Promise<unknown>
): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE`);
    const [state] = await tx
      .select({ id: domain_blacklist_state.id })
      .from(domain_blacklist_state)
      .where(eq(domain_blacklist_state.id, 1))
      .limit(1);
    if (state) throw new Error('Domain blacklist is already initialized; refusing to overwrite it');

    const raw = await readLegacy();
    const config: BlacklistDomainsConfig =
      raw === null
        ? { domains: [], updated_at: null, updated_by: null, updated_by_email: null }
        : { ...LegacySettingsSchema.parse(JSON.parse(raw)), domains: [] };
    if ((await readLegacy()) !== raw) {
      throw new Error(
        'Legacy blacklist changed during initialization; freeze admin edits and retry'
      );
    }
    const domains = await tx
      .select({ domain: blacklisted_domains.domain })
      .from(blacklisted_domains)
      .limit(1);
    await writeSettings(config);
    await tx
      .insert(domain_blacklist_state)
      .values({ id: 1, use_env_fallback: domains.length === 0 });
  });
}
