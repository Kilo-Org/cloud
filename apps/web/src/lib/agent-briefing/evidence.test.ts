jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {} }));
import {
  BRIEFING_MAX_EXCERPT_BYTES,
  BRIEFING_MAX_SESSIONS,
  BRIEFING_MAX_SNAPSHOT_BYTES,
  redactBriefingExcerpt,
  truncateBriefingUtf8,
} from '@kilocode/app-shared/agent-briefing';
import { buildBriefingSnapshot } from './evidence';

function session(index: number) {
  return {
    session_id: `ses_snapshot_${index}`,
    title: `Session ${index}`,
    status: 'idle',
    last_activity_at: '2026-10-28 07:00:00+00',
    briefing_excerpt: {
      messageId: `message_${index}`,
      completedAt: '2026-10-28T06:59:00.000Z',
      text: 'Completed response',
    },
    pr_url: null,
    pr_link_verified_at: null,
    live_summary: null,
  };
}
it('counts only selected sessions and reports omitted sessions without claiming full coverage', () => {
  const facts = buildBriefingSnapshot(
    Array.from({ length: BRIEFING_MAX_SESSIONS + 1 }, (_, index) => session(index))
  );
  expect(facts.sessions).toHaveLength(BRIEFING_MAX_SESSIONS);
  expect(facts.scorecard).toEqual({
    sessions: BRIEFING_MAX_SESSIONS,
    pullRequests: 0,
    blockers: 0,
  });
  expect(facts.truncated).toBe(true);
  expect(facts.coverage).toEqual({
    activity: 'partial',
    blockers: 'partial',
    pullRequests: 'partial',
  });
});
it('bounds serialized snapshots including duplicate source rendering and multibyte excerpts', () => {
  const rows = Array.from({ length: BRIEFING_MAX_SESSIONS }, (_, index) => ({
    ...session(index),
    title: '界'.repeat(160),
    briefing_excerpt: {
      messageId: 'done',
      completedAt: '2026-10-28T07:00:00.000Z',
      text: '界'.repeat(2000),
    },
    pr_url: `https://github.com/example/repo/pull/${index}?${'a'.repeat(1000)}`,
    pr_link_verified_at: '2026-10-28T07:00:00.000Z',
  }));
  const facts = buildBriefingSnapshot(rows);
  expect(Buffer.byteLength(JSON.stringify(facts), 'utf8')).toBeLessThanOrEqual(
    BRIEFING_MAX_SNAPSHOT_BYTES
  );
  expect(facts.truncated).toBe(true);
  expect(facts.scorecard.sessions).toBe(facts.sessions.length);
  for (const source of facts.sources)
    if (source.excerpt)
      expect(Buffer.byteLength(source.excerpt, 'utf8')).toBeLessThanOrEqual(
        BRIEFING_MAX_EXCERPT_BYTES
      );
});
it('includes only safe verified pull request metadata and current blocked state', () => {
  const facts = buildBriefingSnapshot([
    {
      ...session(0),
      status: 'question',
      pr_url: 'https://github.com/example/repo/pull/1?token=private',
      pr_link_verified_at: '2026-10-28T07:00:00.000Z',
    },
    { ...session(1), pr_url: 'https://github.com/example/repo/pull/2' },
    {
      ...session(2),
      pr_url: 'javascript:alert(1)',
      pr_link_verified_at: '2026-10-28T07:00:00.000Z',
    },
  ]);
  expect(facts.scorecard).toEqual({ sessions: 3, pullRequests: 1, blockers: 1 });
  expect(facts.sources.find(source => source.kind === 'pull_request')?.url).toBe(
    'https://github.com/example/repo/pull/1'
  );
});
it('redacts before applying a UTF8 boundary without partial code points', () => {
  const text = redactBriefingExcerpt('token=private-value user@example.com ' + '😀'.repeat(1000));
  expect(text).not.toContain('private-value');
  expect(text).not.toContain('user@example.com');
  expect(text).not.toContain('\uFFFD');
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(BRIEFING_MAX_EXCERPT_BYTES);
  expect(truncateBriefingUtf8('a😀b', 4)).toBe('a');
});

it('includes bounded plan, changes and failure metadata without duplicating final excerpts into blockers', () => {
  const facts = buildBriefingSnapshot([
    {
      ...session(0),
      status: 'permission',
      live_summary: {
        step: { verb: 'thinking', target: null },
        plan: { done: 1, total: 3, current: 'Check changes password=private-value' },
        changes: { files: 2, added: 5, removed: 1 },
        failure: { kind: 'tool' },
      },
    },
  ]);
  expect(facts.scorecard.blockers).toBe(1);
  expect(facts.sources.find(source => source.kind === 'blocker')?.excerpt).toBeUndefined();
  const metadata = facts.sources.find(source => source.kind === 'artifact');
  expect(metadata?.excerpt).toContain('[redacted credential]');
  expect(metadata?.excerpt).not.toMatch(/private-value|thinking/);
});

it('counts a verified pull request once across selected sessions', () => {
  const facts = buildBriefingSnapshot(
    [0, 1].map(index => ({
      ...session(index),
      pr_url: 'https://github.com/example/repo/pull/1',
      pr_link_verified_at: '2026-10-28T07:00:00.000Z',
    }))
  );
  expect(facts.scorecard.pullRequests).toBe(1);
  expect(facts.scorecard.sessions).toBe(2);
});

it('keeps the completion time of an older available response distinct from newer session activity', () => {
  const row = session(0);
  row.briefing_excerpt.completedAt = '2026-10-27T20:00:00.000Z';
  const facts = buildBriefingSnapshot([row]);
  expect(facts.sources.find(source => source.kind === 'activity')?.occurredAt).toBe(
    row.briefing_excerpt.completedAt
  );
});
