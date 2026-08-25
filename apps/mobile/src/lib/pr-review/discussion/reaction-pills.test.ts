import { describe, expect, it } from 'vitest';

import { REACTION_EMOJI, reactionLabel, selectReactionPills } from './reaction-pills';
import { REVIEW_REACTION_CONTENTS } from './review-discussion-types';

describe('selectReactionPills', () => {
  it('filters zero-count buckets', () => {
    expect(
      selectReactionPills([
        { content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
        { content: 'HEART', count: 0, viewerHasReacted: true },
      ])
    ).toEqual([{ content: 'THUMBS_UP', count: 2, viewerHasReacted: false }]);
  });

  it('filters unknown contents', () => {
    expect(
      selectReactionPills([
        { content: 'THUMBS_UP', count: 1, viewerHasReacted: false },
        { content: 'PARTY_PARROT', count: 9, viewerHasReacted: true },
      ])
    ).toEqual([{ content: 'THUMBS_UP', count: 1, viewerHasReacted: false }]);
  });

  it('preserves DTO order', () => {
    expect(
      selectReactionPills([
        { content: 'HEART', count: 1, viewerHasReacted: true },
        { content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
        { content: 'ROCKET', count: 3, viewerHasReacted: false },
      ])
    ).toEqual([
      { content: 'HEART', count: 1, viewerHasReacted: true },
      { content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
      { content: 'ROCKET', count: 3, viewerHasReacted: false },
    ]);
  });

  it('returns empty for an empty input', () => {
    expect(selectReactionPills([])).toEqual([]);
  });
});

describe('REACTION_EMOJI and reactionLabel', () => {
  it('cover all 8 REVIEW_REACTION_CONTENTS', () => {
    expect(REVIEW_REACTION_CONTENTS).toHaveLength(8);
    for (const content of REVIEW_REACTION_CONTENTS) {
      expect(REACTION_EMOJI[content]).toBeTruthy();
      expect(typeof REACTION_EMOJI[content]).toBe('string');
      expect(reactionLabel(content)).toBeTruthy();
      expect(typeof reactionLabel(content)).toBe('string');
    }
  });
});
