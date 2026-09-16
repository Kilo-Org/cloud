import { clearFilePartCache } from '@/components/agents/file-part-cache';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearSessionAutoApprove } from '@/components/agents/session-auto-approve';
import { clearToolCardImageCache } from '@/components/agents/tool-card-image-cache';
import { clearClipboardImages } from '@/lib/agent-attachments/clipboard-image';
import { clearArtifactMirror } from '@/lib/artifacts/artifact-mirror';
import { resetArtifactMirrorSyncState } from '@/lib/artifacts/artifact-mirror-sync';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { reapTempFiles } from '@/lib/temp-file-registry';

/**
 * Clear the session-scoped local state that must not leak across an account
 * boundary: trusted hosts, confirmed markdown images, media caches, per-session
 * auto-approve flags, the browsable artifact mirror, and app-owned temp copies.
 * Every member is synchronous and best-effort; one member's throw falls through
 * to the members after it, and to the caller's own sign-in/sign-out state reset.
 */
export function clearSessionScopedState(): void {
  runClear(clearTrustedHosts);
  runClear(clearMarkdownImageConfirmMemory);
  runClear(clearToolCardImageCache);
  runClear(clearFilePartCache);
  runClear(clearClipboardImages);
  runClear(clearSessionAutoApprove);
  // Wiping the mirror is what makes "signed out shows nothing to browse" true;
  // dropping the engine memo keeps a completed run from repopulating it.
  runClear(clearArtifactMirror);
  runClear(resetArtifactMirrorSyncState);
  runClear(() => {
    reapTempFiles({ all: true });
  });
}

/** One best-effort clear: a throw never stops the clears that follow it. */
function runClear(clear: () => void): void {
  try {
    clear();
  } catch {
    // Session-scoped teardown continues with the remaining members.
  }
}
