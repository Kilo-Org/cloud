import { type ModelSelection } from '@kilocode/cloud-agent-sdk';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

/**
 * The dispatch hook's inputs, extracted so the hook file stays within the
 * repo's line cap (the same split `new-session-configure-form-props` makes).
 */
export type UseRemoteSpawnDispatchArgs = {
  organizationId: string | undefined;
  /**
   * The current new-session agent mode for the spawn target. Omitted for
   * callers without a mode (share-gate); the CLI then uses its default.
   */
  mode?: string;
  /**
   * The validated wire model selection for the active target. Never inherited:
   * the caller owns it because it depends on the target instance's catalog.
   * Undefined means "let the CLI use its default".
   */
  selection?: ModelSelection;
  runOnInstance: InstancePickerInstance | null;
  setRunOnInstance: (next: InstancePickerInstance | null) => void;
  /**
   * Existing `activeSessions.listInstances` query's `refetch` (the slice of
   * `useQuery(...).refetch()` we need: new data on success, throws on
   * failure). The route already owns this query (it's what powers the
   * selector's `instanceList`); we reuse it here so a retryable spawn
   * failure refreshes the same source of truth the picker reads from.
   */
  refetchInstances: () => Promise<{
    data: { instances: InstancePickerInstance[] } | undefined;
  }>;
  /**
   * The most recent list the route knows about. Used as the
   * membership fallback if the refetch fails.
   */
  instanceList: InstancePickerInstance[];
  /**
   * Relative launch folder for the new remote session (`""` means the CLI's
   * own launch directory). Omitted from the wire when empty (undefined).
   */
  directory?: string;
  /**
   * Snapshot of the composer, read once at press time. When it returns a
   * payload the ready path stages it, and the destination composer submits it
   * once. Optional: a caller with no composer omits it.
   */
  getSubmitPayload?: () => SharePayload | null;
  /**
   * Kilo session id the clone/continue form clones from. When set, the spawn
   * carries `cloneFromKiloSessionId` only if the selected instance advertises
   * `sessionClone`, and clone/import failures surface through
   * `onCloneImportFailure` instead of the generic spawn toast.
   */
  cloneFromKiloSessionId?: string | null;
  /**
   * Inclusive fork cut ("Fork from here"). Sent beside the clone source only
   * when the instance advertises `sessionCloneAtMessage`; otherwise the spawn
   * is refused with the inline "update the CLI" reason (fail closed: an old
   * CLI would ignore the cut and clone the whole session).
   */
  cloneUpToMessageId?: string | null;
  /**
   * Composer text for the new session (a forked user message). Delivered as a
   * one-shot composer prefill that the user sends themselves.
   */
  forkPrefillText?: string | null;
  /**
   * Invoked with an inline failure i18n key when a clone/import spawn fails
   * non-retryably (delivered CLI clone error, or the instance lacks
   * `sessionClone`). The route shows the key under "Run on" and disables Start.
   */
  onCloneImportFailure?: (key: string) => void;
  /**
   * Invoked when `onStart` admits the press-time snapshot and commits to a
   * spawn attempt: the caller already passed voice settlement (it only calls
   * `onStart` after the voice input settled) and `resolveRemoteSpawnAdmission`
   * allowed the payload. A tap that never reaches a spawn — blocked
   * admission, cancelled voice submit, or a `null` selection — never fires
   * this, so callers can arm draft clearing on exactly the attempts that
   * happened.
   */
  onSpawnAdmitted?: () => void;
  /**
   * Invoked when a committed spawn settles without navigating (retryable or
   * non-retryable). Callers use it to re-arm an abandon guard that
   * `onSpawnAdmitted` armed, so a later back/swipe still confirms.
   */
  onSpawnFailed?: () => void;
  /**
   * Invoked right before a `ready` spawn navigates (the success replace). The
   * clone entry uses it to arm a one-shot busy leave-lock bypass so the
   * success navigation is not intercepted as an abandon.
   */
  onSpawnReady?: () => void;
  /**
   * Invoked with the spawned session id when a `ready` spawn navigates, so a
   * caller that started from a to-do can link the session to it. Runs before
   * the navigation, beside `onSpawnReady`.
   */
  onSpawnSucceeded?: (sessionId: string) => void;
};

/**
 * A remote spawn's settled or timed-out failure, rendered inline by the form
 * (the dispatch no longer toasts it). `retryable` carries the retry control;
 * a terminal one says what the server or transport reported instead.
 */
export type RemoteSpawnFailure = {
  retryable: boolean;
  message: string;
};

export type UseRemoteSpawnDispatchResult = {
  /**
   * `true` while the dispatch's pre-spawn window is open (instance refetch,
   * live resolution, and the spawn itself). The post-failure refetch runs
   * outside this flag, so the button releases as soon as the outcome is
   * known and the recovery bookkeeping finishes quietly.
   */
  isSpawningRemote: boolean;
  /**
   * The spawn's failure, inline-rendered by the form in the reserved spot
   * above Start. A retryable failure carries the retry control; a terminal
   * one says what the server or transport reported. Cleared on the next
   * Start attempt or a target change.
   */
  remoteSpawnFailure: RemoteSpawnFailure | null;
  /**
   * `true` after a retryable spawn failure reset the selection
   * because the previously-selected `connectionId` dropped off the
   * refetched list. Drives the inline "disconnected" note under
   * the selector.
   */
  showInstanceDisconnectedNote: boolean;
  /**
   * `onStart` for the route's "Start session" CTA when a remote
   * target is selected. No-op when the selection is `null` (the
   * route should have routed the cloud-agent path through
   * `submitCreate` instead, but the guard is defensive). Fires
   * `onSpawnAdmitted` only once a spawn attempt is actually
   * committed to (voice settlement + admission passed).
   */
  onStart: () => void;
  /**
   * Called by the "Run on" selector when the user picks a new
   * instance or switches back to Cloud Agent. Clears the inline
   * "disconnected" note — the note is only meaningful while the
   * selector is on the post-fallback default.
   */
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
};
