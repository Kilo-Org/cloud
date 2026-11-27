import { beforeEach, describe, expect, it } from '@jest/globals';
import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq } from 'drizzle-orm';

import {
  isSyncStale,
  parseIsoTimestamp,
  recordSyncCompleted,
  SYNC_JOB_STALE_AFTER_MS,
} from './sync-state';

const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('parseIsoTimestamp', () => {
  it('returns null for missing or invalid values', () => {
    expect(parseIsoTimestamp(null)).toBeNull();
    expect(parseIsoTimestamp('')).toBeNull();
    expect(parseIsoTimestamp('not-a-date')).toBeNull();
  });

  it('parses ISO timestamps', () => {
    expect(parseIsoTimestamp('2026-08-11T12:00:00.000Z')).toEqual(
      new Date('2026-08-11T12:00:00.000Z')
    );
  });
});

describe('isSyncStale', () => {
  it('is fresh when the last run is less than 1 hour ago', () => {
    expect(isSyncStale(new Date(NOW.getTime() - SYNC_JOB_STALE_AFTER_MS + 1), NOW)).toBe(false);
  });

  it('is stale when the last run is at least 1 hour ago', () => {
    expect(isSyncStale(new Date(NOW.getTime() - SYNC_JOB_STALE_AFTER_MS), NOW)).toBe(true);
  });

  it('is not stale when no run is recorded', () => {
    expect(isSyncStale(null, NOW)).toBe(false);
  });
});

describe('recordSyncCompleted', () => {
  beforeEach(async () => {
    await db
      .delete(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1));
  });

  async function readSyncState() {
    const [row] = await db.select().from(ai_gateway_sync_providers_state);
    return row;
  }

  it('records completion per job without touching the other job', async () => {
    const providersCompletedAt = await recordSyncCompleted('providers');
    const before = await readSyncState();
    expect(new Date(before.last_completed_at ?? '').toISOString()).toBe(providersCompletedAt);
    expect(before.direct_byok_last_completed_at).toBeNull();

    const directByokCompletedAt = await recordSyncCompleted('direct_byok');
    const after = await readSyncState();
    expect(new Date(after.direct_byok_last_completed_at ?? '').toISOString()).toBe(
      directByokCompletedAt
    );
    expect(new Date(after.last_completed_at ?? '').toISOString()).toBe(providersCompletedAt);
  });

  it('keeps a later stored completion', async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    await db.insert(ai_gateway_sync_providers_state).values({ id: 1, last_completed_at: later });

    await recordSyncCompleted('providers');

    const state = await readSyncState();
    expect(new Date(state.last_completed_at ?? '').toISOString()).toBe(later);
  });
});
