import type { DrizzleClient } from '@kilocode/db/client';
import { blacklisted_domains, domain_blacklist_state } from '@kilocode/db/schema';
import {
  BlacklistDomainsConfigSchema,
  type BlacklistDomainsConfig,
} from '@kilocode/worker-utils/account-access';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';

const LegacyConfigSchema = BlacklistDomainsConfigSchema.extend({ domains: z.array(z.string()) });
const BATCH_SIZE = 1000;

export async function backfillDomainBlacklist(
  db: DrizzleClient['db'],
  readLegacy: () => Promise<string | null>,
  writeSettings: (settings: BlacklistDomainsConfig) => Promise<unknown>
): Promise<void> {
  const raw = await readLegacy();
  const config = raw
    ? LegacyConfigSchema.parse(JSON.parse(raw))
    : { domains: [], updated_at: null, updated_by: null, updated_by_email: null };
  const domains = [...new Set(config.domains.map(domain => domain.toLowerCase()))];

  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('domain-blacklist-backfill'))`);
    const [state] = await tx
      .select({ id: domain_blacklist_state.id })
      .from(domain_blacklist_state)
      .where(eq(domain_blacklist_state.id, 1))
      .limit(1);
    if (state) throw new Error('Domain blacklist is already initialized; refusing to overwrite it');

    for (let offset = 0; offset < domains.length; offset += BATCH_SIZE) {
      await tx
        .insert(blacklisted_domains)
        .values(domains.slice(offset, offset + BATCH_SIZE).map(domain => ({ domain })))
        .onConflictDoNothing();
    }
    if ((await readLegacy()) !== raw) {
      throw new Error('Legacy blacklist changed during backfill; freeze admin edits and retry');
    }
    await writeSettings({ ...config, domains: [] });
    const [existing] = await tx
      .select({ domain: blacklisted_domains.domain })
      .from(blacklisted_domains)
      .limit(1);
    await tx.insert(domain_blacklist_state).values({ id: 1, use_env_fallback: !existing });
  });
}
