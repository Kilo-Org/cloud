import { clearFilePartCache } from '@/components/agents/file-part-cache';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearSessionAutoApprove } from '@/components/agents/session-auto-approve';
import { clearSessionGoalCollapseState } from '@/components/agents/session-goal-collapse';
import { clearToolCardImageCache } from '@/components/agents/tool-card-image-cache';
import { clearClipboardImages } from '@/lib/agent-attachments/clipboard-image';
import { clearArtifactMirror } from '@/lib/artifacts/artifact-mirror';
import { resetArtifactMirrorSyncState } from '@/lib/artifacts/artifact-mirror-sync';
import { notifyArtifactsChanged } from '@/lib/artifacts/artifact-provider-native';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { clearSystemSearchIndex } from '@/lib/native-system-search';
import { clearRecentPrs } from '@/lib/pr-review/recent-prs';
import { captureTelemetry } from '@/lib/telemetry/error-sink';
import { reapTempFiles } from '@/lib/temp-file-registry';

/**
 * One report per failed OS search clear, tagged so the subsystem is filterable.
 * The previous account's entries stay searchable until a later clear succeeds,
 * so the failure must be visible and a later clear must be able to retry it.
 */
function reportSystemSearchClearFailure(error: unknown): void {
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'system-search', 'error.operation': 'clear' },
  });
}

/**
 * Fire the OS search clear without awaiting, so the caller stays synchronous
 * and never throws, and report a rejection instead of swallowing it. The clear
 * is idempotent: it wipes the app's whole search domain and the fingerprint
 * ledger the indexer diffs against, so the next sync re-indexes whatever the
 * active account can see.
 */
function clearSearchIndexBestEffort(): void {
  // The inner handler owns the rejection, so it can never surface as an
  // unhandled rejection and the caller never observes the await.
  void (async () => {
    try {
      await clearSystemSearchIndex();
    } catch (error) {
      reportSystemSearchClearFailure(error);
    }
  })();
}

/**
 * Re-run the OS search clear on an app launch that restored no session.
 *
 * The sign-out teardown fires the clear once and cannot await it, and the
 * process can be killed before it lands, so a failure there would leave the
 * previous account's session, pull-request and security titles searchable for
 * the whole signed-out window with nothing to retry it — the index sync is
 * gated off while signed out. This is that retry: on a signed-out launch the
 * sync never runs, so a wiped ledger cannot re-index anything, and the next
 * sign-in re-indexes its own account from its own cache.
 */
export function clearSystemSearchIndexOnSignedOutLaunch(): void {
  clearSearchIndexBestEffort();
}

/**
 * Drop the stored PR recents at an account boundary, without awaiting.
 *
 * The recents key is device-global with no account namespace, and the index
 * collector folds `getRecentPrs()` into the OS search documents, so a direct
 * account switch that only wiped the OS index would immediately re-index the
 * previous account's pull requests from these recents. Sign-out already awaits
 * its own `clearRecentPrs()`; firing the same idempotent delete here covers the
 * account switch, where a full sign-out's clear never runs. The delete is
 * FIFO-chained per key and unfenced, so it lands after any in-flight recents
 * write and a later write for the new account chains behind it.
 */
function clearRecentPrsBestEffort(): void {
  void (async () => {
    try {
      await clearRecentPrs();
    } catch (error) {
      captureTelemetry({
        error,
        level: 'warning',
        tags: { 'error.subsystem': 'recent-prs', 'error.operation': 'clear' },
      });
    }
  })();
}

/**
 * Clear the session-scoped local state that must not leak across an account
 * boundary: trusted hosts, confirmed markdown images, media caches, per-session
 * auto-approve and goal-disclosure flags, the browsable artifact mirror,
 * app-owned temp copies, the stored PR recents, and the phone's own search index.
 * Every member is best-effort; one member's throw falls through to the members
 * after it, and to the caller's own sign-in/sign-out state reset. The recents
 * delete and OS search clear are fired without awaiting, so the function stays
 * synchronous; a rejection is reported through telemetry, and the
 * signed-out-launch re-clear retries the index clear.
 */
export function clearSessionScopedState(): void {
  runClear(clearTrustedHosts);
  runClear(clearMarkdownImageConfirmMemory);
  runClear(clearToolCardImageCache);
  runClear(clearFilePartCache);
  runClear(clearClipboardImages);
  runClear(clearSessionAutoApprove);
  runClear(clearSessionGoalCollapseState);
  // Wiping the mirror is what makes "signed out shows nothing to browse" true;
  // dropping the engine memo keeps a completed run from repopulating it. The
  // wipe alone is invisible to an open Files app, which keeps the listing it
  // last read until the platform provider says the tree changed, so the
  // provider is signalled after the wipe — an empty location, never the
  // previous account's folders.
  runClear(clearArtifactMirror);
  runClear(notifyArtifactsChanged);
  runClear(resetArtifactMirrorSyncState);
  runClear(() => {
    reapTempFiles({ all: true });
  });
  // The stored PR recents are account-bound data the index folds in, and the
  // key is device-global, so the account boundary must drop them as well as the
  // index itself. Without this, an account switch re-indexes the previous
  // account's pull requests from the recents the new account then inherits.
  runClear(clearRecentPrsBestEffort);
  // The phone's search index is device-wide, not scoped to the signed-in
  // session, so without this the previous account's session, pull-request and
  // security titles stay searchable in Spotlight and Android app search after a
  // sign-out or an account switch. Fire-and-forget via
  // `clearSearchIndexBestEffort`: the native clear also wipes the fingerprint
  // ledger the indexer diffs against, so the next sync re-indexes whatever the
  // new account can see.
  runClear(clearSearchIndexBestEffort);
}

/** One best-effort clear: a throw never stops the clears that follow it. */
function runClear(clear: () => void): void {
  try {
    clear();
  } catch {
    // Session-scoped teardown continues with the remaining members.
  }
}
