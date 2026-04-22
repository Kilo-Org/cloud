import type { WastelandOutputs } from '@/lib/wasteland/trpc';

export type WantedItem = WastelandOutputs['wasteland']['browseWantedBoard'][number];
export type InboxItem = WastelandOutputs['wasteland']['listInboxItems']['items'][number];
export type RigDetail = NonNullable<WastelandOutputs['wasteland']['getRig']>;
export type RigActivity = WastelandOutputs['wasteland']['listRigActivity'];

/**
 * Callbacks supplied by the hosting page. Captured on the entry so the drawer
 * body can trigger page-level dialogs/mutations without the drawer having to
 * know about them. `null` when a drawer is pushed as a cross-reference from
 * another drawer — in that mode the panel renders as read-only (data +
 * cross-links only; no action buttons). Hoisting actions into a layout-level
 * provider so pushed drawers also get full actions is tracked as a followup.
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
  | {
      type: 'wanted-item';
      wastelandId: string;
      item: WantedItem;
      actions: WantedPanelActions | null;
    }
  | {
      type: 'wanted-item-by-id';
      wastelandId: string;
      itemId: string;
    }
  | {
      type: 'review-item';
      wastelandId: string;
      item: InboxItem;
      actions: ReviewPanelActions | null;
    }
  | { type: 'rig'; wastelandId: string; handle: string };
