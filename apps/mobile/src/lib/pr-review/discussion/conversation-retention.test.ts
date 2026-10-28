import { beforeEach, describe, expect, it } from 'vitest';

import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import {
  clearConversationRetention,
  conversationRetentionKey,
  retainConversation,
  retainConversationAcrossMounts,
} from './conversation-retention';
import { type ConversationComment } from './review-discussion-types';

const GITHUB_REF: ProviderPrRef = { platform: 'github', owner: 'octocat', repo: 'hello', number: 1 };
const COMMENT = { id: 'c1' } as unknown as ConversationComment;

function key(userId: string, organizationId: string | null, ref: ProviderPrRef = GITHUB_REF): string {
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

  it('returns the first-page conversation when it is present', () => {
    const pages = [{ conversation: [comment] }];
    expect(retainConversation(pages, [])).toEqual([comment]);
  });

  it('keeps the retained conversation after the trim drops the first page', () => {
    const retained = [comment];
    const trimmedPages = [{ conversation: [] }];
    expect(retainConversation(trimmedPages, retained)).toBe(retained);
  });

  it('falls back to an empty list when nothing was ever retained', () => {
    expect(retainConversation(undefined, [])).toEqual([]);
  });
});

describe('retainConversationAcrossMounts (remount survival)', () => {
  it('keeps the conversation after a remount over the trimmed cache', () => {
    const retentionKey = key('user_a', null);
    // First mount: page one is loaded and holds the conversation.
    expect(
      retainConversationAcrossMounts(retentionKey, [{ conversation: [COMMENT] }], true)
    ).toEqual([COMMENT]);
    // Remount over the trimmed cache: pages[0] is a later page with [], so the
    // first page is no longer loaded and the retained copy is the source.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], false)).toEqual([
      COMMENT,
    ]);
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
    ).toEqual([]);
  });

  it('does not leak a retained conversation to another account', () => {
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    expect(
      retainConversationAcrossMounts(key('user_b', null), [{ conversation: [] }], false)
    ).toEqual([]);
  });

  it('does not leak a retained conversation to another organization of the same account', () => {
    retainConversationAcrossMounts(key('user_a', 'org_1'), [{ conversation: [COMMENT] }], true);
    expect(
      retainConversationAcrossMounts(key('user_a', 'org_2'), [{ conversation: [] }], false)
    ).toEqual([]);
  });

  it('never stores or serves anything for an unknown tenant', () => {
    // A mount whose identity has not answered does not publish its page.
    expect(retainConversationAcrossMounts(null, [{ conversation: [COMMENT] }], true)).toEqual([
      COMMENT,
    ]);
    expect(retainConversationAcrossMounts(key('user_a', null), [{ conversation: [] }], false)).toEqual(
      []
    );
    // And it is never served an entry another mount stored.
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    expect(retainConversationAcrossMounts(null, [{ conversation: [] }], false)).toEqual([]);
  });

  it('drops every tenant entry on clear', () => {
    retainConversationAcrossMounts(key('user_a', null), [{ conversation: [COMMENT] }], true);
    retainConversationAcrossMounts(key('user_b', 'org_1'), [{ conversation: [COMMENT] }], true);

    clearConversationRetention();

    expect(retainConversationAcrossMounts(key('user_a', null), [{ conversation: [] }], false)).toEqual(
      []
    );
    expect(
      retainConversationAcrossMounts(key('user_b', 'org_1'), [{ conversation: [] }], false)
    ).toEqual([]);
  });

  it('empties the conversation when the live first page loads with none (delete of the last comment)', () => {
    const retentionKey = key('user_a', null);
    // Page one loaded with the comment.
    expect(
      retainConversationAcrossMounts(retentionKey, [{ conversation: [COMMENT] }], true)
    ).toEqual([COMMENT]);
    // Deleting the last conversation comment leaves the live first page loaded
    // and empty: the empty truth wins, so the Discussion reaches its empty
    // state instead of resurrecting the deleted row.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], true)).toEqual([]);
    // A later evicted read of the same key still returns that empty truth.
    expect(retainConversationAcrossMounts(retentionKey, [{ conversation: [] }], false)).toEqual([]);
  });
});
