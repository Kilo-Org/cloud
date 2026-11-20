/**
 * The Chat tab's body decision.
 *
 * A chat starts on a model and is listed from the device, so the tab has two
 * reads of its own: the chat list and the model catalog. Each can answer, fail,
 * or never answer at all — and only an answer is the empty state. A tab that
 * paints "Start a chat" over an unanswered catalog tells the person they have
 * no chats when nothing could load, with a New chat button that cannot start
 * anything.
 *
 * Pure, so the decision is unit-testable apart from React.
 */
export type ChatListSurface =
  /** The chat list's own read failed, or has no scope to read: Retry re-reads. */
  | { readonly kind: 'list-error' }
  /** The model catalog has not answered: nothing can start a chat. */
  | { readonly kind: 'catalog-error'; readonly offline: boolean }
  /** Work is in flight; the skeleton keeps the row frame. */
  | { readonly kind: 'loading' }
  /** The list answered and holds no chat: the one true empty state. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'rows' };

export type ChatListSurfaceInputs = {
  readonly chatCount: number;
  /** The chat list's read answered with a list (its query succeeded). */
  readonly listAnswered: boolean;
  readonly listFailed: boolean;
  /** The chat list's read is in flight (a first load, not a pause). */
  readonly listLoading: boolean;
  /** A chat place exists; without one the list read never starts. */
  readonly hasPlace: boolean;
  /** The catalog read answered with models (it settled, and not as a failure). */
  readonly catalogAnswered: boolean;
  readonly catalogLoading: boolean;
  /** The device's confirmed connectivity, the app-wide offline banner's state. */
  readonly offline: boolean;
};

export function selectChatListSurface(input: ChatListSurfaceInputs): ChatListSurface {
  const { chatCount, listAnswered, listFailed, listLoading } = input;
  const { hasPlace, catalogAnswered, catalogLoading, offline } = input;
  // A list read that cannot run is not an empty list. Nothing scopes it without
  // a chat place, so it would stay pending forever; the card names it, and its
  // Retry re-reads as soon as the scope arrives.
  if (listFailed || (!hasPlace && !listAnswered)) {
    return { kind: 'list-error' };
  }
  // A catalog still in flight can land; one that has not answered and is not
  // fetching cannot. Offline that is the connection, not a server fault, so the
  // card names the offline state (Retry re-reads, and the reconnect refetch
  // clears it on its own).
  if (catalogLoading) {
    return { kind: 'loading' };
  }
  if (!catalogAnswered) {
    return { kind: 'catalog-error', offline };
  }
  if (!listAnswered || listLoading) {
    return { kind: 'loading' };
  }
  return chatCount === 0 ? { kind: 'empty' } : { kind: 'rows' };
}
