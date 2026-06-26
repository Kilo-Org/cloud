import {
  cost_insight_events,
  cost_insight_owner_configs,
  cost_insight_owner_states,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('Cost Insights router', () => {
  it('turns off the threshold and clears the active threshold episode', async () => {
    const user = await insertTestUser();
    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: user.id,
      spend_alerts_enabled: true,
      cost_suggestions_enabled: true,
      spend_threshold_microdollars: 150_000_000,
    });
    await db.insert(cost_insight_owner_states).values({
      owned_by_user_id: user.id,
      threshold_crossing_active: true,
      threshold_crossing_started_at: '2026-06-25T19:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.costInsights.disableThreshold()).resolves.toEqual({ success: true });

    const [config] = await db
      .select()
      .from(cost_insight_owner_configs)
      .where(eq(cost_insight_owner_configs.owned_by_user_id, user.id));
    const [state] = await db
      .select()
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_user_id, user.id));
    const events = await db
      .select()
      .from(cost_insight_events)
      .where(eq(cost_insight_events.owned_by_user_id, user.id));

    expect(config?.spend_threshold_microdollars).toBeNull();
    expect(state).toMatchObject({
      threshold_crossing_active: false,
      active_threshold_event_id: null,
      threshold_crossing_started_at: null,
      threshold_reviewed_at: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'config_changed',
      actor_user_id: user.id,
      description: 'Spend threshold was turned off.',
      snapshot: {
        changedFields: {
          spendThresholdMicrodollars: { old: 150_000_000, new: null },
        },
        settings: {
          spendAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdMicrodollars: null,
        },
      },
    });
  });

  it('paginates filtered event history beyond the first 50 rows', async () => {
    const user = await insertTestUser();
    await db.insert(cost_insight_events).values(
      Array.from({ length: 62 }, (_, index) => ({
        owned_by_user_id: user.id,
        event_type: 'config_changed' as const,
        title: `Settings event ${index + 1}`,
        description: 'Settings changed.',
        occurred_at: new Date(Date.UTC(2026, 5, 25, 0, index)).toISOString(),
      }))
    );

    const caller = await createCallerForUser(user.id);
    const result = await caller.costInsights.listEvents({
      filter: 'settings',
      page: 7,
      pageSize: 10,
    });

    expect(result).toMatchObject({
      filter: 'settings',
      page: 7,
      pageCount: 7,
      totalCount: 62,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events.map(event => event.title)).toEqual([
      'Settings event 2',
      'Settings event 1',
    ]);
  });
});
