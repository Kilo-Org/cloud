import { describe, expect, it } from 'vitest';
import {
  BRIEFING_MAX_EXCERPT_BYTES,
  briefingHasActivity,
  briefingSourceSchema,
  briefingSummarySchema,
  redactBriefingExcerpt,
  truncateBriefingUtf8,
} from './agent-briefing';

describe('scheduled briefing contracts', () => {
  it('bounds multilingual excerpts by UTF8 bytes without broken characters', () => {
    const excerpt = redactBriefingExcerpt('界😀'.repeat(1000));
    expect(excerpt).toBe('界😀'.repeat(Math.floor(BRIEFING_MAX_EXCERPT_BYTES / 7)));
    expect(excerpt).not.toContain('\uFFFD');
    expect(truncateBriefingUtf8('a😀b', 4)).toBe('a');
    expect(truncateBriefingUtf8('a😀b', 5)).toBe('a😀');
  });
  it('redacts sensitive completed-response text before truncation', () => {
    const excerpt = redactBriefingExcerpt(
      'token=secret-value person@example.com https://example.com/path?secret=value'
    );
    expect(excerpt).not.toContain('secret-value');
    expect(excerpt).not.toContain('person@example.com');
    expect(excerpt).not.toContain('?secret');
  });
  it('rejects cost evidence and obsolete regeneration states', () => {
    expect(
      briefingSourceSchema.safeParse({
        id: 'cost',
        sessionId: 'ses_test',
        kind: 'cost',
        title: 'Cost',
        url: '/session',
        occurredAt: '2026-10-28T08:00:00.000Z',
      }).success
    ).toBe(false);
    expect(briefingSummarySchema.shape.status.safeParse('outdated').success).toBe(false);
    expect(briefingHasActivity({ sessions: 0, pullRequests: 0, blockers: 0 })).toBe(false);
  });
});
