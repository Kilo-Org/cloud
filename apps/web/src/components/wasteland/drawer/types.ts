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
  onDone: (item: WantedItem) => void;
  onAccept: (item: WantedItem) => void;
  onReject: (item: WantedItem) => void;
  onCloseItem: (item: WantedItem) => void;
  onUnclaim: (item: WantedItem) => void;
};

/**
 * Which of the three "places" the drawer should open on. Mirrors the
 * three-place model (upstream / fork / pulls) — each surface that opens
 * the drawer should pick the tab that matches the place the user is in.
 *
 * Falls back to `upstream` when the requested tab isn't actually
 * available for the current item (e.g. `branch` requested but the user
 * has no branch).
 */
export type WantedItemTab = 'upstream' | 'branch' | 'pull';

export type WantedPanelLinks = {
  workshopHref?: string;
};

/**
 * Inputs the inline AcceptForm collects from the admin and forwards to
 * the page-level `acceptWantedItem` mutation. Mirrors the canonical
 * `wl accept-upstream` flags (quality / reliability / severity /
 * skill_tags / message).
 */
export type AcceptFormInput = {
  quality: 'excellent' | 'good' | 'fair' | 'poor';
  reliability: 'excellent' | 'good' | 'fair' | 'poor';
  severity: 'leaf' | 'branch' | 'root';
  skillTags?: string[];
  message?: string;
};

export type ReviewPanelActions = {
  upstream: string | null;
  busy: boolean;
  onMerge: (item: InboxItem) => void;
  onCloseAction: (item: InboxItem) => void;
  onComment: (item: InboxItem) => void;
  /**
   * Accept a work-submission. Only invoked from the inline AcceptForm
   * inside the review drawer. The page wires this to the
   * `acceptWantedItem` mutation, threading through the inbox card's
   * `pull_id`, `submitter`, `fork_owner`, `completion_id`, and
   * `evidence_url` so the server skips redundant cross-fork reads.
   */
  onAccept: (item: InboxItem, input: AcceptFormInput) => void;
};

export type WastelandDrawerRef =
  | {
      type: 'wanted-item';
      wastelandId: string;
      item: WantedItem;
      actions: WantedPanelActions | null;
      links?: WantedPanelLinks;
      /** Default tab. Falls back to `upstream` when unavailable. */
      initialTab?: WantedItemTab;
    }
  | {
      type: 'wanted-item-by-id';
      wastelandId: string;
      itemId: string;
      actions?: WantedPanelActions | null;
      links?: WantedPanelLinks;
      /** Default tab. Falls back to `upstream` when unavailable. */
      initialTab?: WantedItemTab;
    }
  | {
      type: 'review-item';
      wastelandId: string;
      item: InboxItem;
      actions: ReviewPanelActions | null;
    }
  | { type: 'rig'; wastelandId: string; handle: string }
  | {
      type: 'post-wanted-item';
      wastelandId: string;
      onSuccess?: () => void;
    }
  | {
      type: 'edit-wanted-item';
      wastelandId: string;
      item: WantedItem;
      onSuccess?: () => void;
    };
