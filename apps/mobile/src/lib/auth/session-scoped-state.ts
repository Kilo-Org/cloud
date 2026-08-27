import { clearFilePartCache } from '@/components/agents/file-part-cache';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearToolCardImageCache } from '@/components/agents/tool-card-image-cache';
import { clearClipboardImages } from '@/lib/agent-attachments/clipboard-image';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { reapTempFiles } from '@/lib/temp-file-registry';

/**
 * Clear the session-scoped local state that must not leak across an account
 * boundary: trusted hosts, confirmed markdown images, media caches, and
 * app-owned temp copies. Every member is synchronous and best-effort; a throw
 * falls through to the caller's own sign-in/sign-out state reset.
 */
export function clearSessionScopedState(): void {
  clearTrustedHosts();
  clearMarkdownImageConfirmMemory();
  clearToolCardImageCache();
  clearFilePartCache();
  clearClipboardImages();
  reapTempFiles({ all: true });
}
