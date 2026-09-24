import { clearFilePartCache } from '@/components/agents/file-part-cache';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearSessionAutoApprove } from '@/components/agents/session-auto-approve';
import { clearToolCardImageCache } from '@/components/agents/tool-card-image-cache';
import { clearClipboardImages } from '@/lib/agent-attachments/clipboard-image';
import { forgetRemoteMcp } from '@/lib/chat/remote-mcp';
import { clearRemoteMcpServers } from '@/lib/chat/remote-mcp-store';
import { clearSettingsToolsEnabled } from '@/lib/chat/settings-tools-switch';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { reapTempFiles } from '@/lib/temp-file-registry';

/**
 * Clear the session-scoped local state that must not leak across an account
 * boundary: trusted hosts, confirmed markdown images, media caches, per-session
 * auto-approve flags, the remote MCP connection and the stored servers behind
 * it, the app-settings-tools group switch, and app-owned temp copies. Every
 * member is synchronous and best-effort; a throw falls through to the caller's
 * own sign-in/sign-out state reset.
 *
 * Both boundaries call this: the sign-out body and the account switch. A clear
 * that only the sign-out path ran would let a direct switch hand the next
 * account the previous one's choice.
 */
export function clearSessionScopedState(): void {
  clearTrustedHosts();
  clearMarkdownImageConfirmMemory();
  clearToolCardImageCache();
  clearFilePartCache();
  clearClipboardImages();
  clearSessionAutoApprove();
  forgetRemoteMcp();
  clearRemoteMcpServers();
  clearSettingsToolsEnabled();
  reapTempFiles({ all: true });
}
