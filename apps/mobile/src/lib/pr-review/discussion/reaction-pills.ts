// Pure reaction-pill selection and emoji/label maps for the Discussion tab.
//
// Single source for GitHub's 8 review-reaction contents: emoji glyphs
// (pill + picker) and human a11y labels. `selectReactionPills` keeps
// only known contents with count > 0, preserving DTO order.

import { i18n } from '@/i18n';

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

const REACTION_LABEL_KEYS = {
  THUMBS_UP: 'prReview.discussion.reactions.thumbsUp',
  THUMBS_DOWN: 'prReview.discussion.reactions.thumbsDown',
  LAUGH: 'prReview.discussion.reactions.laugh',
  HOORAY: 'prReview.discussion.reactions.hooray',
  CONFUSED: 'prReview.discussion.reactions.confused',
  HEART: 'prReview.discussion.reactions.heart',
  ROCKET: 'prReview.discussion.reactions.rocket',
  EYES: 'prReview.discussion.reactions.eyes',
} satisfies Record<ReviewReactionContent, string>;

export function reactionLabel(content: ReviewReactionContent): string {
  return i18n.t(REACTION_LABEL_KEYS[content]);
}

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
