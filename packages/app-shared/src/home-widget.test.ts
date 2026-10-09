import { describe, expect, it } from 'vitest';
import {
  buildHomeWidgetData,
  buildHomeWidgetDetails,
  buildHomeWidgetPresentation,
  buildHomeWidgetPresentationTimeline,
  homeWidgetRefreshAt,
  homeWidgetDataSchema,
  HOME_WIDGET_TITLE_LIMIT,
} from './home-widget';
import { GLANCEABLE_STALE_MS } from './glanceable-agents-snapshot';

const now = Date.parse('2026-10-09T10:00:00.000Z');
const scope = { userId: 'oauth/private-user', organizationId: null, now };

describe('Home-only widget policy', () => {
  it('ranks oldest waits and earliest schedules, bounds lists, and preserves ties', () => {
    const details = buildHomeWidgetDetails([
      { status: 'question', title: 'No known wait' },
      { status: 'permission', title: 'Oldest', statusUpdatedAt: '2026-10-09T08:00:00Z' },
      { status: 'retry', title: 'Stable tie', statusUpdatedAt: '2026-10-09T08:00:00Z' },
      { status: 'permission', title: 'Later', statusUpdatedAt: '2026-10-09T09:00:00Z' },
      { status: 'scheduled', title: 'No wake', scheduledAt: 'invalid' },
      { status: 'scheduled', title: 'First', scheduledAt: '2026-10-09 11:00:00+00' },
      { status: 'scheduled', title: 'Second', scheduledAt: '2026-10-09T12:00:00Z' },
      { status: 'scheduled', title: 'Third', scheduledAt: '2026-10-09T13:00:00Z' },
    ]);
    expect(details.primaryTitle).toBe('Oldest');
    expect(details.waitingAgents.map(row => row.title)).toEqual(['Oldest', 'Stable tie', 'Later']);
    expect(details.scheduledAgents.map(row => row.title)).toEqual(['First', 'Second', 'Third']);
    expect(details.scheduledAgents[0]?.scheduledAt).toBe('2026-10-09T11:00:00.000Z');
  });

  it('keeps missing titles empty for local fallback and never leaks extra row fields', () => {
    const row = {
      status: 'busy',
      title: `\n${'x'.repeat(HOME_WIDGET_TITLE_LIMIT + 1)}`,
      id: 'private-session',
      prompt: 'private-prompt',
      repository: 'private-repository',
    };
    const data = buildHomeWidgetData({ ...scope, sessions: [row] });
    expect(homeWidgetDataSchema.safeParse(data).success).toBe(true);
    expect(data.details.primaryTitle).toHaveLength(HOME_WIDGET_TITLE_LIMIT);
    expect(JSON.stringify(data.snapshot)).not.toContain('xxx');
    for (const forbidden of [row.id, row.prompt, row.repository, scope.userId]) {
      expect(JSON.stringify(data)).not.toContain(forbidden);
    }
    expect(buildHomeWidgetDetails([{ status: 'permission' }]).waitingAgents[0]?.title).toBe('');
  });

  it('uses one priority and excludes every zero-count secondary row', () => {
    const data = buildHomeWidgetData({
      ...scope,
      sessions: [
        { status: 'scheduled', title: 'Soon', scheduledAt: '2026-10-09T11:00:00Z' },
        { status: 'idle', title: 'Quiet' },
      ],
    });
    const home = buildHomeWidgetPresentation(data, now);
    expect(home.primaryKind).toBe('scheduled');
    expect(home.primaryTitle).toBe('Soon');
    expect(home.secondaryCounts).toEqual([{ kind: 'idle', count: 1 }]);
    expect(home.scheduledAt).toBe('2026-10-09T11:00:00Z');
    const running = buildHomeWidgetData({
      ...scope,
      sessions: [
        { status: 'busy', title: 'Running' },
        { status: 'scheduled', title: 'Soon' },
      ],
    });
    expect(buildHomeWidgetPresentation(running, now).primaryKind).toBe('running');
    const waiting = buildHomeWidgetData({
      ...scope,
      sessions: [
        { status: 'busy', title: 'Running' },
        { status: 'question', title: 'Older question', statusUpdatedAt: '2026-10-09T09:00:00Z' },
        {
          status: 'permission',
          title: 'Approve',
          statusUpdatedAt: '2026-10-09T09:30:00Z',
          approvalKey: 'a'.repeat(64),
        },
      ],
    });
    expect(buildHomeWidgetPresentation(waiting, now)).toMatchObject({
      primaryKind: 'needsInput',
      primaryTitle: 'Approve',
      canApprove: true,
      approvalKey: 'a'.repeat(64),
    });
    const unknownRequest = buildHomeWidgetData({
      ...scope,
      sessions: [{ status: 'permission', title: 'Approve' }],
    });
    expect(buildHomeWidgetPresentation(unknownRequest, now)).toMatchObject({
      canApprove: false,
      approvalKey: null,
    });
  });

  it('retains expired counts and honest checkedAt without inventing activity at a missed wake', () => {
    const data = buildHomeWidgetData({
      ...scope,
      sessions: [{ status: 'scheduled', title: 'Wake', scheduledAt: '2026-10-09T10:15:00Z' }],
    });
    expect(buildHomeWidgetPresentation(data, now).stale).toBe(false);
    expect(buildHomeWidgetPresentation(data, now + GLANCEABLE_STALE_MS).stale).toBe(true);
    data.snapshot.status = 'expired';
    const later = now + 10 * 60 * 60 * 1000;
    expect(buildHomeWidgetPresentation(data, later)).toMatchObject({
      status: 'content',
      primaryKind: 'scheduled',
      primaryCount: 1,
      checkedAt: new Date(now).toISOString(),
      stale: true,
      awaitingUpdate: true,
      canCreate: true,
    });
    expect(homeWidgetRefreshAt(data, later)).toBe(later + 30 * 60 * 1000);
    const missing = buildHomeWidgetData({ ...scope, sessions: [{ status: 'scheduled' }] });
    expect(buildHomeWidgetPresentation(missing, later)).toMatchObject({
      primaryKind: 'scheduled',
      scheduledAt: null,
      awaitingUpdate: false,
    });
  });

  it('hides retained private work on explicit auth/privacy terminals and never manufactures work', () => {
    const data = buildHomeWidgetData({
      ...scope,
      sessions: [{ status: 'permission', title: 'Private' }],
    });
    for (const status of ['signed_out', 'privacy'] as const) {
      data.snapshot.status = status;
      expect(buildHomeWidgetPresentation(data, now)).toMatchObject({
        status,
        primaryKind: null,
        primaryCount: 0,
        secondaryCounts: [],
        primaryTitle: null,
        waitingAgents: [],
        scheduledAgents: [],
        canCreate: false,
        canApprove: false,
      });
    }
    const expiredWithoutConfirmation = buildHomeWidgetData({
      ...scope,
      sessions: [],
      status: 'expired',
    });
    expect(buildHomeWidgetPresentation(expiredWithoutConfirmation, now)).toMatchObject({
      status: 'unavailable',
      primaryKind: null,
      primaryCount: 0,
      checkedAt: null,
    });
  });

  it('requests active/quiet cadence and an earlier future wake without tight overdue polling', () => {
    const active = buildHomeWidgetData({ ...scope, sessions: [{ status: 'busy' }] });
    const idle = buildHomeWidgetData({ ...scope, sessions: [{ status: 'idle' }] });
    const empty = buildHomeWidgetData({ ...scope, sessions: [] });
    const scheduled = buildHomeWidgetData({
      ...scope,
      sessions: [{ status: 'scheduled', scheduledAt: '2026-10-09T10:05:00Z' }],
    });
    expect(homeWidgetRefreshAt(active, now)).toBe(now + 30 * 60 * 1000);
    expect(homeWidgetRefreshAt(idle, now)).toBe(now + 2 * 60 * 60 * 1000);
    expect(homeWidgetRefreshAt(empty, now)).toBe(now + 2 * 60 * 60 * 1000);
    expect(homeWidgetRefreshAt(scheduled, now)).toBe(now + 5 * 60 * 1000);
    expect(homeWidgetRefreshAt(scheduled, now + 5 * 60 * 1000)).toBe(now + 35 * 60 * 1000);
  });
});

describe('native Home presentation timeline', () => {
  it('sorts and deduplicates stale/wake boundaries and uses the same presentation policy', () => {
    const data = buildHomeWidgetData({
      ...scope,
      sessions: [
        {
          status: 'scheduled',
          scheduledAt: '2026-10-09T10:05:00Z',
        },
      ],
    });
    const timeline = buildHomeWidgetPresentationTimeline(data, now);
    expect(timeline.map(entry => entry.at)).toEqual([
      now,
      now + 5 * 60 * 1000,
      now + GLANCEABLE_STALE_MS,
    ]);
    expect(timeline[1]?.home.awaitingUpdate).toBe(true);
    expect(timeline[2]?.home.stale).toBe(true);
    for (const entry of timeline) {
      expect(entry.home).toEqual(buildHomeWidgetPresentation(data, entry.at));
    }
    data.snapshot.scheduledAt = new Date(now + GLANCEABLE_STALE_MS).toISOString();
    expect(buildHomeWidgetPresentationTimeline(data, now)).toHaveLength(2);
    expect(buildHomeWidgetPresentationTimeline(data, now + GLANCEABLE_STALE_MS)).toHaveLength(1);
    data.snapshot.status = 'privacy';
    expect(buildHomeWidgetPresentationTimeline(data, now)).toHaveLength(1);
  });
});
