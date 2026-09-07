import { describe, expect, it } from 'vitest';

import { buildPrTimeline, labelChipColors, reviewerStateTone } from './overview-meta';

type TimelineInput = Parameters<typeof buildPrTimeline>[0];

function pr(overrides: Partial<TimelineInput> = {}): TimelineInput {
  return {
    state: 'open',
    createdAt: '2026-03-01T12:00:00Z',
    updatedAt: '2026-03-02T09:30:00Z',
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    ...overrides,
  };
}

describe('buildPrTimeline', () => {
  it('reports the last update for an open pull request', () => {
    expect(buildPrTimeline(pr())).toEqual([
      { id: 'opened', labelKey: 'prReview.overview.openedAgo', iso: '2026-03-01T12:00:00Z' },
      { id: 'updated', labelKey: 'prReview.overview.updatedAgo', iso: '2026-03-02T09:30:00Z' },
    ]);
  });

  it('names the merge actor when GitHub reports one', () => {
    const entries = buildPrTimeline(
      pr({
        state: 'merged',
        mergedAt: '2026-03-03T10:00:00Z',
        closedAt: '2026-03-03T10:00:00Z',
        mergedBy: { login: 'hubot', avatarUrl: null },
      })
    );
    expect(entries[1]).toEqual({
      id: 'merged',
      labelKey: 'prReview.overview.mergedByAgo',
      iso: '2026-03-03T10:00:00Z',
      login: 'hubot',
    });
  });

  it('drops the actor from the merge entry when GitHub omits it', () => {
    const entries = buildPrTimeline(
      pr({ state: 'merged', mergedAt: '2026-03-03T10:00:00Z', mergedBy: null })
    );
    expect(entries[1]).toEqual({
      id: 'merged',
      labelKey: 'prReview.overview.mergedAgo',
      iso: '2026-03-03T10:00:00Z',
    });
  });

  it('falls back to the closed entry when a merged pull request has no merge time', () => {
    const entries = buildPrTimeline(
      pr({ state: 'merged', mergedAt: null, closedAt: '2026-03-03T10:00:00Z' })
    );
    expect(entries[1]?.id).toBe('closed');
  });

  it('falls back to the updated entry when a closed pull request has no close time', () => {
    expect(buildPrTimeline(pr({ state: 'closed', closedAt: null }))[1]?.id).toBe('updated');
  });

  it('reports the close time for a closed pull request', () => {
    const entries = buildPrTimeline(pr({ state: 'closed', closedAt: '2026-03-04T08:00:00Z' }));
    expect(entries[1]).toEqual({
      id: 'closed',
      labelKey: 'prReview.overview.closedAgo',
      iso: '2026-03-04T08:00:00Z',
    });
  });
});

describe('labelChipColors', () => {
  it('writes dark text on a light label', () => {
    expect(labelChipColors('d4c5f9')).toEqual({ background: '#d4c5f9', text: '#1f2328' });
  });

  it('writes white text on a dark label', () => {
    expect(labelChipColors('0e8a16')).toEqual({ background: '#0e8a16', text: '#ffffff' });
  });

  it('rejects anything that is not a six-digit hex', () => {
    expect(labelChipColors('')).toBeNull();
    expect(labelChipColors('#d73a4a')).toBeNull();
    expect(labelChipColors('fff')).toBeNull();
    expect(labelChipColors('zzzzzz')).toBeNull();
  });
});

describe('reviewerStateTone', () => {
  it('separates the two states that change the merge outcome', () => {
    expect(reviewerStateTone('APPROVED')).toBe('good');
    expect(reviewerStateTone('CHANGES_REQUESTED')).toBe('destructive');
    expect(reviewerStateTone('COMMENTED')).toBe('muted');
    expect(reviewerStateTone('PENDING')).toBe('muted');
  });
});
