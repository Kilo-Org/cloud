import { sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

const SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY = 'sync-providers:snapshot';

/** Held by provider sync while it publishes a `models_by_provider` snapshot. */
export async function lockSnapshotPublication(tx: DrizzleTransaction) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY}))`
  );
}

/** Waits for an in-flight publication, so the latest snapshot id read afterwards stays current. */
export async function lockSnapshotPublicationShared(tx: DrizzleTransaction) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext(${SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY}))`
  );
}
