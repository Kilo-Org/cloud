import { clearFilePartCache } from '@/components/agents/file-part-cache';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearSessionAutoApprove } from '@/components/agents/session-auto-approve';
import { clearUserSessionTitles } from '@/components/agents/session-detail-rename-state';
import { clearSessionGoalCollapseState } from '@/components/agents/session-goal-collapse';
import { clearToolCardImageCache } from '@/components/agents/tool-card-image-cache';
import { clearClipboardImages } from '@/lib/agent-attachments/clipboard-image';
import { clearSessionCatalogBestEffort } from '@/lib/app-actions/session-catalog';
import { clearArtifactMirror } from '@/lib/artifacts/artifact-mirror';
import { resetArtifactMirrorSyncState } from '@/lib/artifacts/artifact-mirror-sync';
import { notifyArtifactsChanged } from '@/lib/artifacts/artifact-provider-native';
import { clearChatBackends } from '@/lib/chat/backend-store';
import { forgetRemoteMcp } from '@/lib/chat/remote-mcp';
import { clearRemoteMcpServers } from '@/lib/chat/remote-mcp-store';
import { clearSettingsToolsEnabled } from '@/lib/chat/settings-tools-switch';
import { clearFormDrafts } from '@/lib/form-draft';
import { clearRepoSelectionSenders } from '@/lib/hooks/repo-selection-senders';
import { clearTrustedImageHosts } from '@/lib/hooks/use-trusted-image-hosts';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { clearLastOpenedSession } from '@/lib/last-opened-session';
import { clearLastRoute } from '@/lib/last-route';
import { noteLauncherSurfacesCleared } from '@/lib/launcher-surfaces-publish';
import { clearLauncherSurfaces } from '@/lib/native-launcher-surfaces';
import { clearSystemSearchIndex } from '@/lib/native-system-search';
import { clearConversationRetention } from '@/lib/pr-review/discussion/conversation-retention';
import { clearRecentPrs } from '@/lib/pr-review/recent-prs';
import { reportSystemSearchFailure } from '@/lib/system-search-telemetry';
import { captureTelemetry } from '@/lib/telemetry/error-sink';
import { reapTempFiles } from '@/lib/temp-file-registry';

/**
 * Fire the OS search clear without awaiting, so the caller stays synchronous
 * and never throws, and report a rejection instead of swallowing it. A timeout
 * is not reported: the next signed-out launch repeats the clear. The clear
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
      reportSystemSearchFailure('clear', error);
    }
  })();
}

/**
 * Re-runs the clears for a launch with no stored session, so the surfaces that
 * outlive a session start empty.
 */
export function clearSystemSearchIndexOnSignedOutLaunch(): void {
  clearSearchIndexBestEffort();
  clearSessionCatalogBestEffort();
  runClear(clearArtifactMirror);
  runClear(notifyArtifactsChanged);
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
 * boundary: trusted hosts, trusted image hosts, confirmed markdown images, media
 * caches, typed profile form drafts, per-session auto-approve and goal-disclosure
 * flags, the remote MCP
 * connection and the stored servers behind it, the app-settings-tools group
 * switch, the debounced repository-selection send state, the browsable
 * artifact mirror, app-owned temp copies, the stored PR recents, the retained
 * PR discussion conversation, the phone's own search index, the OS launcher
 * shortcuts and tile, and the durable last-opened-session and last-route
 * records. Every member is
 * best-effort; one member's throw falls through to the members after it, and to
 * the caller's own sign-in/sign-out state reset. The recents delete and OS
 * search clear are fired without awaiting, so the function stays synchronous;
 * a rejection is reported through telemetry, and the signed-out-launch re-clear
 * retries the device-wide members.
 *
 * Both boundaries call this: the sign-out body and the account switch. A clear
 * that only the sign-out path ran would let a direct switch hand the next
 * account the previous one's choice.
 */
export function clearSessionScopedState(): void {
  // The link allowlist and the separate image-host trust are both SecureStore
  // preferences. An account boundary must drop both, or a host trusted by the
  // previous account keeps auto-loading its images for the next one.
  runClear(clearTrustedHosts);
  runClear(clearTrustedImageHosts);
  runClear(clearMarkdownImageConfirmMemory);
  runClear(clearToolCardImageCache);
  runClear(clearFilePartCache);
  runClear(clearClipboardImages);
  // Profile form drafts hold what someone typed, including a secret value, in
  // this process's memory, so the account boundary drops them with the other
  // stores: a form left open under the previous account must not reopen under
  // the next one.
  runClear(clearFormDrafts);
  runClear(clearSessionAutoApprove);
  runClear(forgetRemoteMcp);
  runClear(clearRemoteMcpServers);
  runClear(clearChatBackends);
  runClear(clearSettingsToolsEnabled);
  // The debounced repository selection keeps a pending toggle, its timer, and
  // the server baseline it diffs against, so the account boundary drops them
  // with the other account-scoped members.
  runClear(clearRepoSelectionSenders);
  runClear(clearUserSessionTitles);
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
  // Cross-account separation for the retained PR discussion conversation: the
  // sign-in account switch and the sign-out clear it with the other
  // account-scoped members. Within one account, the organization component of
  // `conversationRetentionKey` separates organizations' reads of the same PR.
  runClear(clearConversationRetention);
  // The phone's search index is device-wide, not scoped to the signed-in
  // session, so without this the previous account's session, pull-request and
  // security titles stay searchable in Spotlight and Android app search after a
  // sign-out or an account switch. Fire-and-forget via
  // `clearSearchIndexBestEffort`: the native clear also wipes the fingerprint
  // ledger the indexer diffs against, so the next sync re-indexes whatever the
  // new account can see.
  runClear(clearSearchIndexBestEffort);
  // The App Intents session catalog is device-wide for the same reason, and it
  // is the same titles in another place: without this, Shortcuts and Siri would
  // keep offering the previous account's sessions after a sign-out or an
  // account switch, and the next sync would republish them from the cache that
  // has not been cleared yet.
  runClear(clearSessionCatalogBestEffort);
  // The OS launcher surfaces are device-wide too, and their labels come from the
  // signed-in account's sessions: the Android dynamic shortcuts and
  // quick-settings tile, and the home-screen quick actions. The account
  // boundary drops them with the other account-scoped members, and records the
  // clear in the surface revision, so a mounted publisher writes the derived
  // list again on the derivation that follows.
  runClear(() => {
    clearLauncherSurfaces();
    noteLauncherSurfacesCleared();
  });
  // The durable last-opened session record and the last-route record are read
  // through the active account's user id, and they are also the inputs the
  // launcher surfaces and the relaunch restore derive from. The account
  // boundary deletes both with the other account-bound records, so both belong
  // to the account that is signed in.
  runClear(clearLastOpenedSession);
  runClear(clearLastRoute);
}

/** One best-effort clear: a throw never stops the clears that follow it. */
function runClear(clear: () => void): void {
  try {
    clear();
  } catch {
    // Session-scoped teardown continues with the remaining members.
  }
}
