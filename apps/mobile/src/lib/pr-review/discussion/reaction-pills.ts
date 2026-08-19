// Pure reaction-pill selection and emoji/label maps for the Discussion tab.
//
// Single source for GitHub's 8 review-reaction contents: emoji glyphs
// (pill + picker) and human a11y labels. `selectReactionPills` keeps
// only known contents with count > 0, preserving DTO order.

import {
  REVIEW_REACTION_CONTENTS,
  type ReviewReactionContent,
} from '@/lib/pr-review/discussion/review-discussion-types';

export const REACTION_EMOJI = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
} satisfies Record<ReviewReactionContent, string>;

export const REACTION_LABEL = {
  THUMBS_UP: 'Thumbs up',
  THUMBS_DOWN: 'Thumbs down',
  LAUGH: 'Laugh',
  HOORAY: 'Hooray',
  CONFUSED: 'Confused',
  HEART: 'Heart',
  ROCKET: 'Rocket',
  EYES: 'Eyes',
} satisfies Record<ReviewReactionContent, string>;

const KNOWN_CONTENTS = new Set<string>(REVIEW_REACTION_CONTENTS);

export type ReactionPill = {
  readonly content: ReviewReactionContent;
  readonly count: number;
  readonly viewerHasReacted: boolean;
};

/**
 * From DTO reaction buckets, keep only the 8 known contents with
 * `count > 0`, preserving input order.
 */
export function selectReactionPills(
  reactions: readonly {
    readonly content: string;
    readonly count: number;
    readonly viewerHasReacted: boolean;
  }[]
): ReactionPill[] {
  const pills: ReactionPill[] = [];
  for (const r of reactions) {
    if (r.count > 0 && KNOWN_CONTENTS.has(r.content)) {
      pills.push({
        content: r.content as ReviewReactionContent,
        count: r.count,
        viewerHasReacted: r.viewerHasReacted,
      });
    }
  }
  return pills;
}
