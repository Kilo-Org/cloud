import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeSearchMock = vi.hoisted(() => ({
  clearSystemSearchIndex: vi.fn<() => Promise<void>>(),
}));

const telemetryMock = vi.hoisted(() => ({
  captureTelemetry: vi.fn(),
}));

vi.mock('@/lib/native-system-search', () => nativeSearchMock);

vi.mock('@/lib/telemetry/error-sink', () => telemetryMock);

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
import {
  clearSessionScopedState,
  clearSystemSearchIndexOnSignedOutLaunch,
} from './session-scoped-state';
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

  it('stays synchronous and reports a rejected native clear instead of swallowing it', async () => {
    const failure = new Error('The system search index did not respond.');
    nativeSearchMock.clearSystemSearchIndex.mockRejectedValue(failure);

    expect(() => {
      clearSessionScopedState();
    }).not.toThrow();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);

    // The fire-and-forget clear owns its own rejection handler: the failure is
    // reported, never left unhandled (an unhandled rejection fails this file).
    await vi.waitFor(() => {
      expect(telemetryMock.captureTelemetry).toHaveBeenCalledWith({
        error: failure,
        level: 'warning',
        tags: { 'error.subsystem': 'system-search', 'error.operation': 'clear' },
      });
    });
  });
});

describe('clearSystemSearchIndexOnSignedOutLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeSearchMock.clearSystemSearchIndex.mockResolvedValue(undefined);
  });

  it('re-runs the idempotent OS search clear for the signed-out launch', () => {
    clearSystemSearchIndexOnSignedOutLaunch();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('reports a failed re-clear through telemetry and never throws', async () => {
    const failure = new Error('The system search index did not respond.');
    nativeSearchMock.clearSystemSearchIndex.mockRejectedValue(failure);

    expect(() => {
      clearSystemSearchIndexOnSignedOutLaunch();
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(telemetryMock.captureTelemetry).toHaveBeenCalledWith({
        error: failure,
        level: 'warning',
        tags: { 'error.subsystem': 'system-search', 'error.operation': 'clear' },
      });
    });
  });
});
