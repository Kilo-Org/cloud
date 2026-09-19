import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeSearchMock = vi.hoisted(() => ({
  clearSystemSearchIndex: vi.fn<() => Promise<void>>(),
}));

const telemetryMock = vi.hoisted(() => ({
  captureTelemetry: vi.fn(),
}));

const recentPrsMock = vi.hoisted(() => ({
  clearRecentPrs: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/native-system-search', () => nativeSearchMock);

vi.mock('@/lib/telemetry/error-sink', () => telemetryMock);

// The stored PR recents are the other account-bound store this clear owns; the
// recents module reaches SecureStore on import, so it is mocked here.
vi.mock('@/lib/pr-review/recent-prs', () => recentPrsMock);

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
  isSessionGoalCollapsed,
  setSessionGoalCollapsed,
} from '@/components/agents/session-goal-collapse';
import {
  clearSessionScopedState,
  clearSystemSearchIndexOnSignedOutLaunch,
} from './session-scoped-state';
/* eslint-enable import/first */

describe('clearSessionScopedState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeSearchMock.clearSystemSearchIndex.mockResolvedValue(undefined);
    recentPrsMock.clearRecentPrs.mockResolvedValue(undefined);
  });

  it('clears the OS search index exactly once per call', () => {
    clearSessionScopedState();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);

    clearSessionScopedState();
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(2);
  });

  it('drops the stored PR recents the index folds into every document set', () => {
    // A direct account switch runs this clear but not sign-out's own recents
    // clear; without it the collector re-indexes the previous account's PRs.
    clearSessionScopedState();
    expect(recentPrsMock.clearRecentPrs).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected recents clear instead of leaving it unhandled', async () => {
    const failure = new Error('The stored pull requests did not clear.');
    recentPrsMock.clearRecentPrs.mockRejectedValue(failure);

    expect(() => {
      clearSessionScopedState();
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(telemetryMock.captureTelemetry).toHaveBeenCalledWith({
        error: failure,
        level: 'warning',
        tags: { 'error.subsystem': 'recent-prs', 'error.operation': 'clear' },
      });
    });
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

// The two in-memory stores that hold per-session flags stay real, so the
// wiring is what is under test.
describe('clearSessionScopedState', () => {
  it('drops the per-session goal disclosure flag on sign-out', () => {
    setSessionGoalCollapsed('session-scoped-goal', true);
    expect(isSessionGoalCollapsed('session-scoped-goal')).toBe(true);

    clearSessionScopedState();

    expect(isSessionGoalCollapsed('session-scoped-goal')).toBe(false);
  });
});
