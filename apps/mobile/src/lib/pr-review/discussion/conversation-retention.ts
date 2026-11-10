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

import { type ProviderPrRef, providerPrRefKey } from '@kilocode/app-shared/provider-review';

import { type ConversationComment } from './review-discussion-types';

const conversationRetention = new Map<string, readonly ConversationComment[]>();

// Shared empty reference so an empty first page keeps a stable identity across
// renders instead of a fresh `[]` literal on every call.
const EMPTY_CONVERSATION: readonly ConversationComment[] = [];

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
 * Fallback used once the retention trim has evicted page one.
 *
 * The backend returns conversation comments on the first page only; later
 * pages carry `conversation: []`. Once `maxPages` trims the oldest page,
 * `pages[0]` is no longer the first page, so reading `pages[0].conversation`
 * would erase the comments. Prefer the current first page's conversation when
 * it is non-empty; otherwise fall back to the retained value. While page one
 * IS loaded the caller uses its value directly (see
 * `retainConversationAcrossMounts`), including when it is empty.
 */
export function retainConversation<C>(
  pages: readonly { conversation: readonly C[] }[] | undefined,
  retained: readonly C[]
): readonly C[] {
  const first = pages?.[0]?.conversation;
  return first && first.length > 0 ? first : retained;
}

/**
 * Read and update the retained first-page conversation for one tenant's PR.
 *
 * `firstPageLoaded` tells the two cases apart. When the live first page is
 * loaded (`pages[0]` is page one), it is the source of truth — including when
 * it is empty, so deleting the last conversation comment empties the
 * discussion and a later eviction still reads that empty truth. Only once the
 * retention trim has evicted page one (later pages carry `conversation: []` by
 * backend contract) does the retained copy become the source, so the comments
 * survive the trim and the tab's unmount/remount cycle.
 *
 * `key` is null while the signed-in tenant is not known: the live page is still
 * returned, but nothing is read from or written to the store.
 */
export function retainConversationAcrossMounts(
  key: string | null,
  pages: readonly { conversation: readonly ConversationComment[] }[] | undefined,
  firstPageLoaded: boolean
): readonly ConversationComment[] {
  const retained =
    key === null ? EMPTY_CONVERSATION : (conversationRetention.get(key) ?? EMPTY_CONVERSATION);
  const conversation = firstPageLoaded
    ? (pages?.[0]?.conversation ?? EMPTY_CONVERSATION)
    : retainConversation(pages, retained);
  if (key !== null && conversation !== retained) {
    conversationRetention.set(key, conversation);
  }
  return conversation;
}
