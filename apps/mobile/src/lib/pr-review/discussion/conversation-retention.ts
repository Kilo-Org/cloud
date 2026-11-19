// Retention store for the Discussion tab's first-page conversation.
//
// The backend returns conversation comments on the first page only (later
// pages carry `conversation: []`), so the tab keeps the last first-page value
// outside the query cache: the retention trim drops the oldest page once
// `maxPages` is exceeded, and `PrReviewScreen` unmounts the tab on every tab
// change, which a component ref cannot survive.
//
// The store lives for the whole JS process, so a key must name the tenant that
// read the data as well as the PR/MR: the signed-in Kilo user, the organization
// the provider call ran under, and the provider ref. A `null` key means the
// tenant is not known yet (the identity read has not answered); that call reads
// and writes nothing here, so a mount without a tenant can never publish or be
// served another tenant's comments.
//
// The stored entry carries the server's truncation marker beside the comments.
// The server drops issue-comment pages past its ceiling and says so, and the
// tab must keep saying so after the trim evicts page one and after a remount:
// a marker read from `pages[0]` alone would be lost exactly then, and the
// partial discussion would read as a complete one.

import { type ProviderPrRef, providerPrRefKey } from '@kilocode/app-shared/provider-review';

import { type ConversationComment } from './review-discussion-types';

/**
 * The first-page conversation as the Discussion tab keeps it: the comments and
 * whether the server cut the conversation at its page ceiling.
 */
export type RetainedConversation<C> = {
  readonly comments: readonly C[];
  readonly truncated: boolean;
};

/**
 * One discussion page, as much as this module reads. `truncated` is the
 * server's optional marker: an absent field is a complete conversation.
 */
type ConversationPage<C> = {
  readonly conversation: readonly C[];
  readonly truncated?: boolean;
};

const conversationRetention = new Map<string, RetainedConversation<ConversationComment>>();

// Shared empty references so an empty first page keeps a stable identity across
// renders instead of a fresh object on every call.
const EMPTY_RETAINED: RetainedConversation<never> = { comments: [], truncated: false };

/**
 * The retention key for one tenant's read of one PR/MR.
 *
 * JSON-encoded so each part stays unambiguous: the provider ref key is itself a
 * JSON array and travels as one escaped element, so no user id, organization id
 * or ref can be spelled so that two different triples produce one key.
 */
export function conversationRetentionKey(input: {
  userId: string;
  organizationId: string | null;
  ref: ProviderPrRef;
}): string {
  return JSON.stringify([input.userId, input.organizationId, providerPrRefKey(input.ref)]);
}

/**
 * Drop every retained conversation.
 *
 * The account boundary calls this (sign-out and a direct account switch): the
 * entries were read under the departing tenant's provider connection, and the
 * next account must not be served them even for the same ref.
 */
export function clearConversationRetention(): void {
  conversationRetention.clear();
}

/**
 * The page's conversation as one entry, or null when the page carries no
 * comments. The page's own marker is read here and nowhere else, so one page's
 * comments can never be paired with another page's marker.
 *
 * The retained entry keeps its identity when its parts do not change, so a memo
 * keyed on it does not re-run over a refetch that returned the same page.
 */
function entryOf<C>(
  page: ConversationPage<C> | undefined,
  retained: RetainedConversation<C>
): RetainedConversation<C> | null {
  if (!page || page.conversation.length === 0) {
    return null;
  }
  const truncated = page.truncated === true;
  if (retained.comments === page.conversation && retained.truncated === truncated) {
    return retained;
  }
  return { comments: page.conversation, truncated };
}

/**
 * The live first page as an entry. Page one is the truth even when it is
 * empty — the last conversation comment was deleted — so an empty page clears
 * the retained comments and its marker instead of resurrecting them.
 */
function liveEntry<C>(
  page: ConversationPage<C> | undefined,
  retained: RetainedConversation<C>
): RetainedConversation<C> {
  return entryOf(page, retained) ?? (retained.comments.length === 0 ? retained : EMPTY_RETAINED);
}

/**
 * Fallback used once the retention trim has evicted page one.
 *
 * The backend returns conversation comments on the first page only; later
 * pages carry `conversation: []`. Once `maxPages` trims the oldest page,
 * `pages[0]` is no longer the first page, so reading `pages[0].conversation`
 * would erase the comments. Prefer the current first page's conversation when
 * it is non-empty; otherwise fall back to the retained entry, marker included.
 */
export function retainConversation<C>(
  pages: readonly ConversationPage<C>[] | undefined,
  retained: RetainedConversation<C>
): RetainedConversation<C> {
  return entryOf(pages?.[0], retained) ?? retained;
}

/**
 * Read and update the retained first-page conversation for one tenant's PR.
 *
 * `firstPageLoaded` tells the two cases apart. When the live first page is
 * loaded (`pages[0]` is page one), it is the source of truth. Only once the
 * retention trim has evicted page one (later pages carry `conversation: []` by
 * backend contract) does the retained copy become the source, so the comments
 * and their truncation marker survive the trim and the tab's unmount/remount
 * cycle.
 *
 * `key` is null while the signed-in tenant is not known: the live page is still
 * returned, but nothing is read from or written to the store.
 */
export function retainConversationAcrossMounts(
  key: string | null,
  pages: readonly ConversationPage<ConversationComment>[] | undefined,
  firstPageLoaded: boolean
): RetainedConversation<ConversationComment> {
  const retained =
    key === null ? EMPTY_RETAINED : (conversationRetention.get(key) ?? EMPTY_RETAINED);
  const entry = firstPageLoaded
    ? liveEntry(pages?.[0], retained)
    : retainConversation(pages, retained);
  if (key !== null && entry !== retained) {
    conversationRetention.set(key, entry);
  }
  return entry;
}
