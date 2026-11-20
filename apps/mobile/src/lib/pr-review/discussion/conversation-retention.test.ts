import { beforeEach, describe, expect, it } from 'vitest';

import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import {
  clearConversationRetention,
  conversationRetentionKey,
  retainConversation,
  retainConversationAcrossMounts,
  type RetainedConversation,
} from './conversation-retention';
import { type ConversationComment } from './review-discussion-types';

const GITHUB_REF: ProviderPrRef = {
  platform: 'github',
  owner: 'octocat',
  repo: 'hello',
  number: 1,
};
const COMMENT = { id: 'c1' } as unknown as ConversationComment;
const EMPTY: RetainedConversation<ConversationComment> = { comments: [], truncated: false };

function key(
  userId: string,
  organizationId: string | null,
  ref: ProviderPrRef = GITHUB_REF
): string {
  return conversationRetentionKey({ userId, organizationId, ref });
}

beforeEach(() => {
  clearConversationRetention();
});

describe('conversationRetentionKey', () => {
  it('gives one key to the same user, organization and ref', () => {
    expect(key('user_a', null)).toBe(key('user_a', null));
    expect(key('user_a', 'org_1')).toBe(key('user_a', 'org_1'));
  });

  it('separates accounts and organizations for the same PR', () => {
    const personal = key('user_a', null);
    expect(key('user_b', null)).not.toBe(personal);
    expect(key('user_a', 'org_1')).not.toBe(personal);
    expect(key('user_a', 'org_2')).not.toBe(key('user_a', 'org_1'));
  });

  it('keeps user and organization fields from running together', () => {
    expect(key('ab', 'c')).not.toBe(key('a', 'bc'));
    expect(key('ab', null)).not.toBe(key('a', 'b'));
  });

  it('separates refs, including same-named repositories on different providers', () => {
    expect(key('user_a', null, { ...GITHUB_REF, number: 2 })).not.toBe(key('user_a', null));
    expect(
      key('user_a', null, {
        platform: 'gitlab',
        projectPath: 'octocat/hello',
        mrIid: 1,
        instanceHint: 'https://gitlab.com',
      })
    ).not.toBe(key('user_a', null));
    expect(
      key('user_a', null, {
        platform: 'bitbucket',
        workspace: 'octocat',
        repoSlug: 'hello',
        prId: 1,
      })
    ).not.toBe(key('user_a', null));
  });
});

describe('retainConversation (retention-safe conversation)', () => {
  const comment = { id: 'c1' };
  const empty: RetainedConversation<{ id: string }> = { comments: [], truncated: false };

  it('returns the first-page conversation when it is present', () => {
    const pages = [{ conversation: [comment] }];
    expect(retainConversation(pages, empty)).toEqual({ comments: [comment], truncated: false });
  });

  it('keeps the retained conversation after the trim drops the first page', () => {
    const retained = { comments: [comment], truncated: true };
    const trimmedPages = [{ conversation: [] }];
    expect(retainConversation(trimmedPages, retained)).toBe(retained);
  });

  it('falls back to an empty entry when nothing was ever retained', () => {
    expect(retainConversation(undefined, empty)).toBe(empty);
  });

  it('reads the truncation marker from the page that carries the comments', () => {
    // One page's marker can never travel with another page's comments: the
    // trimmed page has no comments, so the retained marker stands.
    const retained = { comments: [comment], truncated: true };
    expect(retainConversation([{ conversation: [], truncated: false }], retained)).toBe(retained);
    expect(
      retainConversation([{ conversation: [{ id: 'c2' }], truncated: true }], empty).truncated
    ).toBe(true);
  });
});

describe('retainConversationAcrossMounts (remount survival)', () => {
  it('keeps the conversation after a remount over the trimmed cache', () => {
    const retentionKey = key('user_a', null);
    // First mount: page one is loaded and holds the conversation.
    expect(
      retainConversationAcrossMounts(retentionKey, [{ conversation: [COMMENT] }], true)
    ).toEqual({ comments: [COMMENT], truncated: false });
    // Remount over the trimmed cache: pages[0] is a later page with [], so the
    // first page is no longer loaded and the retained copy is the source.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], false)).toEqual({
      comments: [COMMENT],
      truncated: false,
    });
  });

  it('keeps the truncation marker after the trim evicts page one', () => {
    const retentionKey = key('user_a', null);
    expect(
      retainConversationAcrossMounts(
        retentionKey,
        [{ conversation: [COMMENT], truncated: true }],
        true
      )
    ).toEqual({ comments: [COMMENT], truncated: true });
    // The evicted read carries later pages only: their empty conversation and
    // absent marker must not clear the retained marker.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], false)).toEqual({
      comments: [COMMENT],
      truncated: true,
    });
  });

  it('stores a complete conversation without a marker', () => {
    const retentionKey = key('user_a', null);
    retainConversationAcrossMounts(retentionKey, [{ conversation: [COMMENT] }], true);
    expect(
      retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], false).truncated
    ).toBe(false);
  });

  it('does not leak the conversation across different PRs', () => {
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    // A different PR has never retained anything, so it stays empty.
    expect(
      retainConversationAcrossMounts(
        key('user_a', null, { ...GITHUB_REF, number: 2 }),
        [{ conversation: [] }],
        false
      )
    ).toEqual(EMPTY);
  });

  it('does not leak a retained conversation to another account', () => {
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    expect(
      retainConversationAcrossMounts(key('user_b', null), [{ conversation: [] }], false)
    ).toEqual(EMPTY);
  });

  it('does not leak a retained conversation to another organization of the same account', () => {
    retainConversationAcrossMounts(key('user_a', 'org_1'), [{ conversation: [COMMENT] }], true);
    expect(
      retainConversationAcrossMounts(key('user_a', 'org_2'), [{ conversation: [] }], false)
    ).toEqual(EMPTY);
  });

  it('never stores or serves anything for an unknown tenant', () => {
    // A mount whose identity has not answered does not publish its page.
    expect(retainConversationAcrossMounts(null, [{ conversation: [COMMENT] }], true)).toEqual({
      comments: [COMMENT],
      truncated: false,
    });
    expect(
      retainConversationAcrossMounts(key('user_a', null), [{ conversation: [] }], false)
    ).toEqual(EMPTY);
    // And it is never served an entry another mount stored.
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    expect(retainConversationAcrossMounts(null, [{ conversation: [] }], false)).toEqual(EMPTY);
  });

  it('drops every tenant entry on clear', () => {
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    retainConversationAcrossMounts(key('user_b', 'org_1'), [{ conversation: [COMMENT] }], true);

    clearConversationRetention();

    expect(
      retainConversationAcrossMounts(key('user_a', null), [{ conversation: [] }], false)
    ).toEqual(EMPTY);
    expect(
      retainConversationAcrossMounts(key('user_b', 'org_1'), [{ conversation: [] }], false)
    ).toEqual(EMPTY);
  });

  it('empties the conversation when the live first page loads with none (delete of the last comment)', () => {
    const retentionKey = key('user_a', null);
    // Page one loaded with the comment.
    expect(
      retainConversationAcrossMounts(retentionKey, [{ conversation: [COMMENT] }], true)
    ).toEqual({ comments: [COMMENT], truncated: false });
    // Deleting the last conversation comment leaves the live first page loaded
    // and empty: the empty truth wins, so the Discussion reaches its empty
    // state instead of resurrecting the deleted row — and the notice goes with
    // it, because an empty discussion cannot be a cut one.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], true)).toEqual(
      EMPTY
    );
    // A later evicted read of the same key still returns that empty truth.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], false)).toEqual(
      EMPTY
    );
  });

  it('keeps one entry identity while its parts do not change', () => {
    const retentionKey = key('user_a', null);
    const comments = [COMMENT];
    const first = retainConversationAcrossMounts(
      retentionKey,
      [{ conversation: comments, truncated: true }],
      true
    );
    // A refetch returns the same page: the memo key stays the same object.
    expect(
      retainConversationAcrossMounts(
        retentionKey,
        [{ conversation: comments, truncated: true }],
        true
      )
    ).toBe(first);
  });
});
