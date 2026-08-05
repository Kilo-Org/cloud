import { describe, expect, it } from 'vitest';

import { reactionPillA11y } from './reaction-pill-a11y';
import { selectReactionPills } from '@/lib/pr-review/discussion/reaction-pills';
import { REVIEW_REACTION_CONTENTS } from '@/lib/pr-review/discussion/review-discussion-types';

/**
 * Feature C — reaction-pill control contract.
 *
 * The helper is pure presentation for a pill that already exists, so the
 * feature states are:
 * - happy: `selected` mirrors `viewerHasReacted` and the label speaks the
 *   visible emoji + count.
 * - disabled unhappy: `accessibilityState.disabled` mirrors the prop and the
 *   label is unchanged (the visual disabled treatment lives in the row).
 * - empty: a zero-count pill is never rendered. `selectReactionPills` keeps
 *   only buckets with `count > 0`, so `ReactionsRow` maps nothing when every
 *   bucket is zero; the named structural test below proves that contract.
 */

describe('reactionPillA11y', () => {
  it('exposes a button role, a spoken label, and the reacted toggle state', () => {
    expect(
      reactionPillA11y({
        emoji: '👍',
        count: 3,
        viewerHasReacted: true,
        disabled: false,
      })
    ).toEqual({
      accessibilityRole: 'button',
      accessibilityLabel: '👍 reaction, 3 reactions',
      accessibilityState: { selected: true, disabled: false },
    });
  });

  it('exposes an unselected state when the viewer has not reacted', () => {
    const props = reactionPillA11y({
      emoji: '❤️',
      count: 1,
      viewerHasReacted: false,
      disabled: false,
    });
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityState).toEqual({ selected: false, disabled: false });
  });

  it('uses singular "reaction" for a count of 1', () => {
    expect(
      reactionPillA11y({
        emoji: '🚀',
        count: 1,
        viewerHasReacted: false,
        disabled: false,
      }).accessibilityLabel
    ).toBe('🚀 reaction, 1 reaction');
  });

  it('uses plural "reactions" for a count other than 1', () => {
    expect(
      reactionPillA11y({
        emoji: '👀',
        count: 2,
        viewerHasReacted: false,
        disabled: false,
      }).accessibilityLabel
    ).toBe('👀 reaction, 2 reactions');
  });

  it('keeps the label unchanged and exposes disabled alongside selected', () => {
    const props = reactionPillA11y({
      emoji: '👍',
      count: 2,
      viewerHasReacted: true,
      disabled: true,
    });
    expect(props.accessibilityLabel).toBe('👍 reaction, 2 reactions');
    expect(props.accessibilityState).toEqual({ selected: true, disabled: true });
  });
});

describe('reaction pill empty state', () => {
  it('selects no pills when every reaction bucket has a zero count', () => {
    // `ReactionsRow` maps `selectReactionPills(reactions)` to pill
    // Pressables, so an empty selection means no pill renders. Every
    // known content present at count 0 must still select nothing.
    expect(
      selectReactionPills(
        REVIEW_REACTION_CONTENTS.map(content => ({
          content,
          count: 0,
          viewerHasReacted: false,
        }))
      )
    ).toEqual([]);
  });
});
