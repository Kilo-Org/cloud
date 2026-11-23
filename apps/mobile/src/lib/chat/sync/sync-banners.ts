/**
 * What a synced chat is doing on another device, and the one notice a
 * tombstone raises. Module state, so a screen subscribes to its own chat
 * rather than owning the status.
 */

export type SyncBanner =
  | { readonly kind: 'none' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'diverged' }
  | { readonly kind: 'live' };

const banners = new Map<string, SyncBanner>();
const bannerListeners = new Set<() => void>();
const NO_BANNER: SyncBanner = { kind: 'none' };

export function bannerOf(sessionId: string): SyncBanner {
  return banners.get(sessionId) ?? NO_BANNER;
}

export function watchBanners(listener: () => void): () => void {
  bannerListeners.add(listener);
  return () => {
    bannerListeners.delete(listener);
  };
}

export function setBanner(sessionId: string, banner: SyncBanner): void {
  if (bannerOf(sessionId).kind === banner.kind) {
    return;
  }
  banners.set(sessionId, banner);
  for (const listener of bannerListeners) {
    listener();
  }
}

/** The outcome screens act on when a synced chat was deleted elsewhere. */
export type DeletedElsewhereListener = (sessionId: string) => void;
const deletedListeners = new Set<DeletedElsewhereListener>();

export function onDeletedElsewhere(listener: DeletedElsewhereListener): () => void {
  deletedListeners.add(listener);
  return () => {
    deletedListeners.delete(listener);
  };
}

export function announceDeleted(sessionId: string): void {
  for (const listener of deletedListeners) {
    listener(sessionId);
  }
}

