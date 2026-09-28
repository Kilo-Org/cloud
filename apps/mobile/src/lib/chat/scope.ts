import { type ChatOrg } from './layers';

/**
 * Which account and organization a chat belongs to.
 *
 * A chat is private to the person who had it and to the organization whose
 * credit paid for it, so every read and every write is scoped. The harness SDK
 * holds the conversation and knows nothing about either, which is why this is
 * the app's to keep.
 *
 * Personal has a name of its own rather than an empty one, so a bug that lost
 * the organization cannot quietly read another scope's chats.
 */
function chatScope(userId: string, organizationId: string | null | undefined): string {
  return `${userId}:${organizationId ?? 'personal'}`;
}

/** Where a chat belongs, which every call needs and no chat holds before it opens. */
export type ChatPlace = {
  readonly chatScope: string;
  readonly org: ChatOrg;
};

/**
 * Where a chat belongs, from the account and organization a screen reads.
 *
 * The same inputs answer with the same object. A screen calls this on every
 * render, and a fresh object each time would re-run `useChat`'s open effect on
 * every render — reopening a chat a model switch had just moved off. The shape
 * is readonly, so one instance can be shared.
 *
 * The cache is account-scoped like the chats themselves, so signing out or
 * switching account drops it rather than keeping one account's scopes for the
 * next.
 */
const places = new Map<string, ChatPlace>();

export function chatPlaceOf(
  userId: string | null | undefined,
  organizationId: string | null | undefined
): ChatPlace | null {
  if (userId === null || userId === undefined || userId === '') {
    return null;
  }
  const key = `${userId}\u0000${organizationId ?? ''}`;
  const held = places.get(key);
  if (held !== undefined) {
    return held;
  }
  const made: ChatPlace = {
    chatScope: chatScope(userId, organizationId),
    org:
      organizationId === null || organizationId === undefined || organizationId === ''
        ? { kind: 'personal' }
        : { kind: 'organization', id: organizationId },
  };
  places.set(key, made);
  return made;
}

/** Drops the remembered places, which is what signing out or switching account does. */
export function forgetChatPlaces(): void {
  places.clear();
}
