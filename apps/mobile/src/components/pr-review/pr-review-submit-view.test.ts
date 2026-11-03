import { describe, expect, it } from 'vitest';

import {
  selectGitHubReviewEvents,
  selectPartialSubmitMessage,
  selectSubmitCtaLabel,
} from '@/components/pr-review/pr-review-submit-view';

describe('selectGitHubReviewEvents', () => {
  it('offers only comment on the viewer’s own pull request, ignoring login case', () => {
    expect(selectGitHubReviewEvents({ authorLogin: 'OctoCat', viewerLogin: 'octocat' })).toEqual([
      'comment',
    ]);
  });

  it('keeps the three default events for another author or an unknown identity', () => {
    expect(
      selectGitHubReviewEvents({ authorLogin: 'someone-else', viewerLogin: 'octocat' })
    ).toBeUndefined();
    expect(
      selectGitHubReviewEvents({ authorLogin: undefined, viewerLogin: 'octocat' })
    ).toBeUndefined();
    expect(selectGitHubReviewEvents({ authorLogin: 'octocat', viewerLogin: null })).toBeUndefined();
  });
});

describe('selectSubmitCtaLabel', () => {
  it('uses the plain label when nothing is stale', () => {
    expect(selectSubmitCtaLabel({ freshCount: 3, totalCount: 3 })).toBe('Submit review');
  });

  it('uses the partial label when some items are stale', () => {
    expect(selectSubmitCtaLabel({ freshCount: 2, totalCount: 5 })).toBe('Submit 2 of 5 comments');
  });

  it('uses the partial label even when no item is fresh', () => {
    expect(selectSubmitCtaLabel({ freshCount: 0, totalCount: 4 })).toBe('Submit 0 of 4 comments');
  });
});

describe('selectPartialSubmitMessage', () => {
  it('returns null when nothing is stale', () => {
    expect(selectPartialSubmitMessage({ freshCount: 3, staleCount: 0 })).toBeNull();
  });

  it('reports the posted and kept counts when some items are stale', () => {
    expect(selectPartialSubmitMessage({ freshCount: 2, staleCount: 3 })).toBe(
      'Posted 2 comments. 3 comments point at an older commit and stayed in your queue.'
    );
  });

  it('agrees with a single posted comment and a single stale one', () => {
    expect(selectPartialSubmitMessage({ freshCount: 1, staleCount: 1 })).toBe(
      'Posted 1 comment. 1 comment points at an older commit and stayed in your queue.'
    );
  });

  it('reports zero posted comments when every item is stale', () => {
    expect(selectPartialSubmitMessage({ freshCount: 0, staleCount: 4 })).toBe(
      'Posted 0 comments. 4 comments point at an older commit and stayed in your queue.'
    );
  });
});
