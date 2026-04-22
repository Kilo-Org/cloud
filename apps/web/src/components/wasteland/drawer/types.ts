import type { WastelandOutputs } from '@/lib/wasteland/trpc';

export type WantedItem = WastelandOutputs['wasteland']['browseWantedBoard'][number];
export type InboxItem = WastelandOutputs['wasteland']['listInboxItems']['items'][number];

/**
 * Callbacks supplied by the hosting page. Captured on the entry so the drawer
 * body can trigger page-level dialogs/mutations without the drawer having to
 * know about them. Stored inline (not via context) because the stack state
 * isn't persisted and React re-renders from a parent already see new closures.
 */
export type WantedPanelActions = {
  isAdmin: boolean;
  onClaim: (item: WantedItem) => void;
  onDone: (item: WantedItem) => void;
  onAccept: (item: WantedItem) => void;
  onReject: (item: WantedItem) => void;
  onCloseItem: (item: WantedItem) => void;
  onUnclaim: (item: WantedItem) => void;
};

export type ReviewPanelActions = {
  upstream: string | null;
  busy: boolean;
  onMerge: (item: InboxItem) => void;
  onCloseAction: (item: InboxItem) => void;
  onComment: (item: InboxItem) => void;
};

export type WastelandDrawerRef =
  | { type: 'wanted-item'; item: WantedItem; actions: WantedPanelActions }
  | { type: 'review-item'; item: InboxItem; actions: ReviewPanelActions };
