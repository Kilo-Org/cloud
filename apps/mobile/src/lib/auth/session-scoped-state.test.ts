import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeSearchMock = vi.hoisted(() => ({
  clearSystemSearchIndex: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/native-system-search', () => nativeSearchMock);

// The remaining session-scoped members pull native bindings that the node test
// environment cannot load: use-trusted-hosts -> secure-store-preference ->
// sonner-native -> react-native, and the cache/file modules -> expo-file-system
// / expo-clipboard / expo-crypto. This suite only asserts the OS search clear.
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({ clearTrustedHosts: vi.fn() }));

vi.mock('@/components/agents/markdown-image-confirm', () => ({
  clearMarkdownImageConfirmMemory: vi.fn(),
}));

vi.mock('@/components/agents/tool-card-image-cache', () => ({
  clearToolCardImageCache: vi.fn(),
}));

vi.mock('@/components/agents/file-part-cache', () => ({ clearFilePartCache: vi.fn() }));

vi.mock('@/components/agents/session-auto-approve', () => ({ clearSessionAutoApprove: vi.fn() }));

vi.mock('@/lib/agent-attachments/clipboard-image', () => ({ clearClipboardImages: vi.fn() }));

vi.mock('@/lib/temp-file-registry', () => ({ reapTempFiles: vi.fn() }));

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
import { clearSessionScopedState } from './session-scoped-state';
/* eslint-enable import/first */

describe('clearSessionScopedState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeSearchMock.clearSystemSearchIndex.mockResolvedValue(undefined);
  });

  it('clears the OS search index exactly once per call', () => {
    clearSessionScopedState();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);

    clearSessionScopedState();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(2);
  });

  it('stays synchronous and never throws when the native clear rejects', async () => {
    const failure = new Error('The system search index did not respond.');
    const clearCall = Promise.withResolvers<undefined>();
    nativeSearchMock.clearSystemSearchIndex.mockReturnValue(clearCall.promise);
    // The call is fire-and-forget, so its rejection needs a handler of its own.
    const observed = expect(clearCall.promise).rejects.toThrow(
      'The system search index did not respond.'
    );

    expect(() => {
      clearSessionScopedState();
    }).not.toThrow();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);

    // The function returned above, before the native clear settled and failed.
    clearCall.reject(failure);
    await observed;
  });
});
