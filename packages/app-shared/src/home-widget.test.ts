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

  it('parses PostgreSQL session times for the wait order, scheduled rows, and the wake', () => {
    const details = buildHomeWidgetDetails([
      { status: 'question', title: 'Later', statusUpdatedAt: '2026-10-09 09:30:00.957+00' },
      { status: 'permission', title: 'Oldest', statusUpdatedAt: '2026-10-09 08:00:00+00' },
      { status: 'scheduled', title: 'Wake', scheduledAt: '2026-10-09 09:55:00+00' },
    ]);
    expect(details.primaryTitle).toBe('Oldest');
    expect(details.waitingAgents.map(row => row.title)).toEqual(['Oldest', 'Later']);
    expect(details.scheduledAgents).toEqual([
      { title: 'Wake', scheduledAt: '2026-10-09T09:55:00.000Z' },
    ]);

    const data = buildHomeWidgetData({
      ...scope,
      sessions: [{ status: 'scheduled', title: 'Wake', scheduledAt: '2026-10-09 09:55:00+00' }],
    });
    expect(buildHomeWidgetPresentation(data, now)).toMatchObject({
      primaryKind: 'scheduled',
      scheduledAt: '2026-10-09T09:55:00.000Z',
      awaitingUpdate: true,
    });
    // A snapshot restored from an older producer may still carry the raw form.
    data.snapshot.scheduledAt = '2026-10-09 09:55:00+00';
    expect(buildHomeWidgetPresentation(data, now)).toMatchObject({
      scheduledAt: '2026-10-09T09:55:00.000Z',
      awaitingUpdate: true,
    });
    expect(homeWidgetRefreshAt(data, now)).toBe(now + 30 * 60 * 1000);
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

  it('carries only printed characters in a title', () => {
    const primary = buildHomeWidgetData({
      ...scope,
      sessions: [{ status: 'permission', title: 'Review \u202econfig files' }],
    });
    expect(primary.details.primaryTitle).toBe('Review config files');
    expect(homeWidgetDataSchema.safeParse(primary).success).toBe(true);
    const scheduled = buildHomeWidgetData({
      ...scope,
      sessions: [
        {
          status: 'scheduled',
          title: '\u2066Deploy\u2069 \u200bnow\u2060',
          scheduledAt: '2026-10-09T11:00:00Z',
        },
      ],
    });
    expect(scheduled.details.scheduledAgents[0]?.title).toBe('Deploy now');
  });

  it('drops every non-printing code point and keeps joining characters', () => {
    const dropped = [
      0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061,
      0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
    ];
    const title = `${dropped.map(code => `a${String.fromCodePoint(code)}`).join('')}z`;
    const details = buildHomeWidgetDetails([{ status: 'permission', title }]);
    expect(details.waitingAgents[0]?.title).toBe(`${'a'.repeat(dropped.length)}z`);
    const joined = 'می\u200cخواهم 👨\u200d👩\u200d👧';
    expect(
      buildHomeWidgetDetails([{ status: 'permission', title: joined }]).waitingAgents[0]?.title
    ).toBe(joined);
  });

  it('keeps the details payload printable across every row', () => {
    const data = buildHomeWidgetData({
      ...scope,
      sessions: [
        {
          status: 'permission',
          title: '\u202eApprove\u2066 the\u2069 \u200bplan',
          statusUpdatedAt: '2026-10-09T09:00:00Z',
        },
        {
          status: 'scheduled',
          title: '\ufeffNightly\u2060 run',
          scheduledAt: '2026-10-09T11:00:00Z',
        },
        { status: 'busy', title: '\u200bBuild' },
      ],
    });
    expect(data.details.primaryTitle).toBe('Approve the plan');
    expect(data.details.scheduledAgents[0]?.title).toBe('Nightly run');
    expect(JSON.stringify(data.details)).toMatch(/^[\x20-\x7e]*$/);
  });

  it('bounds the title by printed characters', () => {
    const details = buildHomeWidgetDetails([
      {
        status: 'permission',
        title: `${'\u200b'.repeat(400)}${'y'.repeat(HOME_WIDGET_TITLE_LIMIT + 10)}`,
      },
    ]);
    expect(details.waitingAgents[0]?.title).toHaveLength(HOME_WIDGET_TITLE_LIMIT);
  });

  it('preserves complete emoji at the title limit', () => {
    for (const padding of [HOME_WIDGET_TITLE_LIMIT - 2, HOME_WIDGET_TITLE_LIMIT - 1]) {
      const prefix = 'a'.repeat(padding);
      const details = buildHomeWidgetDetails([
        { status: 'permission', title: `\u200b${prefix}🚀next` },
      ]);
      expect(details.primaryTitle).toBe(
        padding === HOME_WIDGET_TITLE_LIMIT - 2 ? `${prefix}🚀` : prefix
      );
      expect(details.waitingAgents[0]?.title).toBe(details.primaryTitle);
    }
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
    expect(home.scheduledAt).toBe('2026-10-09T11:00:00.000Z');
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

  it('refreshes uncertain empty snapshots on the active cadence', () => {
    for (const status of ['waiting', 'stale', 'expired'] as const) {
      const data = buildHomeWidgetData({ ...scope, sessions: [], status });
      expect(homeWidgetRefreshAt(data, now)).toBe(now + 30 * 60 * 1000);
    }
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
