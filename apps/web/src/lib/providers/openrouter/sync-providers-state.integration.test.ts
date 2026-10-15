import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import { recordSyncCompleted, recordSyncFailure } from '@/lib/providers/openrouter/sync-providers';

async function readState() {
  const [row] = await db
    .select()
    .from(ai_gateway_sync_providers_state)
    .where(eq(ai_gateway_sync_providers_state.id, 1));
  return row;
}

async function deleteState() {
  await db.delete(ai_gateway_sync_providers_state).where(eq(ai_gateway_sync_providers_state.id, 1));
}

describe('sync-providers state', () => {
  beforeEach(deleteState);
  afterEach(deleteState);

  test('holds the full-refresh time back while an entry keeps failing', async () => {
    const first = await recordSyncCompleted([
      { entry: 'openrouter endpoints for a/b', error: '408' },
    ]);
    const second = await recordSyncCompleted([
      { entry: 'openrouter endpoints for a/b', error: '524' },
      { entry: 'models for provider Together', error: 'timed out after 20s' },
    ]);

    expect(second.refreshedThrough).toBe(first.refreshedThrough);
    const state = await readState();
    expect(new Date(state?.last_completed_at ?? '').toISOString()).toBe(first.refreshedThrough);
    expect(state?.refresh_failures).toEqual({
      'openrouter endpoints for a/b': { since: first.refreshedThrough, error: '524' },
      'models for provider Together': { since: second.completedAt, error: 'timed out after 20s' },
    });
  });

  test('advances the full-refresh time once every entry refreshes', async () => {
    await recordSyncCompleted([{ entry: 'openrouter endpoints for a/b', error: '408' }]);
    const recovered = await recordSyncCompleted([]);

    expect(recovered.refreshedThrough).toBe(recovered.completedAt);
    const state = await readState();
    expect(new Date(state?.last_completed_at ?? '').toISOString()).toBe(recovered.completedAt);
    expect(state?.refresh_failures).toEqual({});
  });

  test('records the latest failed run without touching refresh state', async () => {
    const completed = await recordSyncCompleted([
      { entry: 'vercel endpoints for c/d', error: '500' },
    ]);
    await recordSyncFailure(new Error('Fetching OpenRouter providers failed: 524'));

    const state = await readState();
    expect(state?.last_failure_message).toBe('Fetching OpenRouter providers failed: 524');
    expect(state?.last_failed_at).not.toBeNull();
    expect(new Date(state?.last_completed_at ?? '').toISOString()).toBe(completed.refreshedThrough);
    expect(state?.refresh_failures).toEqual({
      'vercel endpoints for c/d': { since: completed.refreshedThrough, error: '500' },
    });
  });

  test('records a failed run before any state exists', async () => {
    await recordSyncFailure('unexpected');

    const state = await readState();
    expect(state?.last_failure_message).toBe('unexpected');
    expect(state?.last_completed_at).toBeNull();
    expect(state?.refresh_failures).toEqual({});
  });
});
