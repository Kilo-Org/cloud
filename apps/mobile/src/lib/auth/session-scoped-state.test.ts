import { beforeEach, expect, it, vi } from 'vitest';

/**
 * The account boundary's one clear.
 *
 * Both boundaries call `clearSessionScopedState` — the sign-out body and a
 * direct account switch — so everything in it is dropped for the next account.
 * The app-settings-tools group switch belongs in it: the switch is
 * account-scoped, and a boundary that skipped it would hand the next account
 * the previous account's choice.
 */

// The group switch rides on the shared SecureStore preference, which pulls
// sonner-native -> react-native (Flow `import typeof`) into the node test
// environment. Mock the native boundaries so the real store under test can be
// seeded, read and cleared.
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-secure-store', () => secureStore);

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

// The other clears beside it pull expo-file-system, expo-clipboard and
// expo-crypto bindings the node environment cannot load; this suite is about
// the group switch, so they are stubs.
vi.mock('@/components/agents/file-part-cache', () => ({ clearFilePartCache: vi.fn() }));
vi.mock('@/components/agents/markdown-image-confirm', () => ({
  clearMarkdownImageConfirmMemory: vi.fn(),
}));
vi.mock('@/components/agents/session-auto-approve', () => ({ clearSessionAutoApprove: vi.fn() }));
vi.mock('@/components/agents/tool-card-image-cache', () => ({ clearToolCardImageCache: vi.fn() }));
vi.mock('@/lib/agent-attachments/clipboard-image', () => ({ clearClipboardImages: vi.fn() }));
vi.mock('@/lib/chat/remote-mcp', () => ({ forgetRemoteMcp: vi.fn() }));
vi.mock('@/lib/chat/remote-mcp-store', () => ({ clearRemoteMcpServers: vi.fn() }));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({ clearTrustedHosts: vi.fn() }));
vi.mock('@/lib/temp-file-registry', () => ({ reapTempFiles: vi.fn() }));

const { clearSessionScopedState } = await import('./session-scoped-state');
const { isSettingsToolsEnabled, setSettingsToolsEnabled } =
  await import('@/lib/chat/settings-tools-switch');

beforeEach(() => {
  // On by default, which is where the boundary must leave it.
  setSettingsToolsEnabled(true);
});

it('resets the settings-tools group switch, so the next account starts from the default', () => {
  setSettingsToolsEnabled(false);
  expect(isSettingsToolsEnabled()).toBe(false);

  clearSessionScopedState();

  // The previous account turned the agent-callable settings tools off. The
  // account that signs in next never made that choice and must not inherit it.
  expect(isSettingsToolsEnabled()).toBe(true);
});
