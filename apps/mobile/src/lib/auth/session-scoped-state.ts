import { clearFilePartCache } from '@/components/agents/file-part-cache';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearSessionAutoApprove } from '@/components/agents/session-auto-approve';
import { clearToolCardImageCache } from '@/components/agents/tool-card-image-cache';
import { clearClipboardImages } from '@/lib/agent-attachments/clipboard-image';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { clearSystemSearchIndex } from '@/lib/native-system-search';
import { reapTempFiles } from '@/lib/temp-file-registry';

/**
 * Clear the session-scoped local state that must not leak across an account
 * boundary: trusted hosts, confirmed markdown images, media caches, per-session
 * auto-approve flags, and app-owned temp copies. Every member is best-effort; a
 * throw falls through to the caller's own sign-in/sign-out state reset. The OS
 * search clear is the one asynchronous member and is fired without awaiting, so
 * the function stays synchronous and never throws.
 */
export function clearSessionScopedState(): void {
  clearTrustedHosts();
  clearMarkdownImageConfirmMemory();
  clearToolCardImageCache();
  clearFilePartCache();
  clearClipboardImages();
  clearSessionAutoApprove();
  reapTempFiles({ all: true });
  // The phone's search index is device-wide, not scoped to the signed-in
  // session, so without this the previous account's session, pull-request and
  // security titles stay searchable in Spotlight and Android app search after a
  // sign-out or an account switch. Fire-and-forget: the native clear also wipes
  // the fingerprint ledger the indexer diffs against, so the next sync
  // re-indexes whatever the new account can see.
  void clearSystemSearchIndex();
}
