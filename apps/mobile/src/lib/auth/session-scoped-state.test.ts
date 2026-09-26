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

/** One tracked entry of the fake filesystem, keyed by the URI parts it was built from. */
const fakeFs = vi.hoisted(() => {
  const deleted: string[] = [];
  const state = { rootExists: true };

  // eslint-disable-next-line unicorn/consistent-function-scoping -- vi.hoisted runs before module scope
  function segmentOf(part: unknown): string {
    return typeof part === 'string' ? part : (part as { uri: string }).uri;
  }

  class DirectoryMock {
    readonly uri: string;
    exists = state.rootExists;
    constructor(...parts: unknown[]) {
      this.uri = parts.map(part => segmentOf(part)).join('/');
    }
    delete(): void {
      deleted.push(this.uri);
      state.rootExists = false;
    }
  }

  const paths: { appleSharedContainers: Record<string, string>; document: string } = {
    appleSharedContainers: {},
    document: 'file:///documents',
  };

  return {
    Directory: DirectoryMock,
    File: vi.fn(),
    Paths: paths,
    deleted,
    state,
  };
});

const mocks = vi.hoisted(() => ({
  clearClipboardImages: vi.fn(),
  clearFilePartCache: vi.fn(),
  clearMarkdownImageConfirmMemory: vi.fn(),
  clearSessionAutoApprove: vi.fn(),
  clearToolCardImageCache: vi.fn(),
  clearRemoteMcpServers: vi.fn(),
  clearSettingsToolsEnabled: vi.fn(),
  clearTrustedHosts: vi.fn(),
  forgetRemoteMcp: vi.fn(),
  notifyArtifactsChanged: vi.fn(),
  reapTempFiles: vi.fn(),
  resetArtifactMirrorSyncState: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: fakeFs.Directory,
  File: fakeFs.File,
  Paths: fakeFs.Paths,
}));
// `artifact-mirror-paths` is the only Platform.OS branch; Android reads the
// mirror from `Paths.document`.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

vi.mock('@/components/agents/file-part-cache', () => ({
  clearFilePartCache: mocks.clearFilePartCache,
}));
vi.mock('@/components/agents/markdown-image-confirm', () => ({
  clearMarkdownImageConfirmMemory: mocks.clearMarkdownImageConfirmMemory,
}));
vi.mock('@/components/agents/session-auto-approve', () => ({
  clearSessionAutoApprove: mocks.clearSessionAutoApprove,
}));
// Partial on purpose: the mirror's manifest reads `extensionForMime` from this
// module, and `clearArtifactMirror` never calls it.
vi.mock('@/components/agents/tool-card-image-cache', () => ({
  clearToolCardImageCache: mocks.clearToolCardImageCache,
}));
vi.mock('@/lib/agent-attachments/clipboard-image', () => ({
  clearClipboardImages: mocks.clearClipboardImages,
}));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  clearTrustedHosts: mocks.clearTrustedHosts,
}));
vi.mock('@/lib/temp-file-registry', () => ({ reapTempFiles: mocks.reapTempFiles }));
// The remote MCP connection, its stored servers and the settings-tools group
// switch are account-scoped; their own suites cover what each clear resets.
vi.mock('@/lib/chat/remote-mcp', () => ({ forgetRemoteMcp: mocks.forgetRemoteMcp }));
vi.mock('@/lib/chat/remote-mcp-store', () => ({
  clearRemoteMcpServers: mocks.clearRemoteMcpServers,
}));
vi.mock('@/lib/chat/settings-tools-switch', () => ({
  clearSettingsToolsEnabled: mocks.clearSettingsToolsEnabled,
}));
// The platform provider bridge: sign-out has to tell an open Files app the tree
// changed, or it keeps the listing it read before the wipe.
vi.mock('@/lib/artifacts/artifact-provider-native', () => ({
  notifyArtifactsChanged: mocks.notifyArtifactsChanged,
}));
// The engine's memo reset is observed through this spy; its own suite covers
// what the reset does to a later run.
vi.mock('@/lib/artifacts/artifact-mirror-sync', () => ({
  resetArtifactMirrorSyncState: mocks.resetArtifactMirrorSyncState,
}));

/** Every mocked member, in declaration order; the mirror and goal stores stay real. */
const SESSION_MEMBERS = [
  mocks.clearTrustedHosts,
  mocks.clearMarkdownImageConfirmMemory,
  mocks.clearToolCardImageCache,
  mocks.clearFilePartCache,
  mocks.clearClipboardImages,
  mocks.clearSessionAutoApprove,
  mocks.forgetRemoteMcp,
  mocks.clearRemoteMcpServers,
  mocks.clearSettingsToolsEnabled,
];

/** Android mirror root: `Paths.document` plus the mirror folder name. */
const MIRROR_ROOT_URI = 'file:///documents/artifacts';

beforeEach(() => {
  vi.clearAllMocks();
  fakeFs.deleted.length = 0;
  fakeFs.state.rootExists = true;
  nativeSearchMock.clearSystemSearchIndex.mockResolvedValue(undefined);
  recentPrsMock.clearRecentPrs.mockResolvedValue(undefined);
});

describe('clearSessionScopedState', () => {
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

// The mirror and goal-disclosure stores stay real, so the wiring is under test.
describe('clearSessionScopedState', () => {
  it('deletes the browsable mirror root', () => {
    clearSessionScopedState();

    expect(fakeFs.deleted).toEqual([MIRROR_ROOT_URI]);
    expect(fakeFs.state.rootExists).toBe(false);
  });

  it('signals the platform provider once the mirror is gone', () => {
    // An open Files app keeps the listing it last read until the provider says
    // the tree changed, so the signal must follow the wipe, never precede it.
    let mirrorWasGone: boolean | null = null;
    mocks.notifyArtifactsChanged.mockImplementationOnce(() => {
      mirrorWasGone = !fakeFs.state.rootExists;
    });

    clearSessionScopedState();

    expect(mocks.notifyArtifactsChanged).toHaveBeenCalledTimes(1);
    expect(mirrorWasGone).toBe(true);
  });

  it('resets the sync engine, clears every member, and reaps all temp copies', () => {
    clearSessionScopedState();

    expect(mocks.resetArtifactMirrorSyncState).toHaveBeenCalledTimes(1);
    expect(mocks.reapTempFiles).toHaveBeenCalledWith({ all: true });
    for (const member of SESSION_MEMBERS) {
      expect(member).toHaveBeenCalledTimes(1);
    }
  });

  it('still deletes the mirror and reaps when an earlier member throws', () => {
    mocks.clearTrustedHosts.mockImplementationOnce(() => {
      throw new Error('secure store unavailable');
    });

    expect(() => {
      clearSessionScopedState();
    }).not.toThrow();

    expect(fakeFs.deleted).toEqual([MIRROR_ROOT_URI]);
    expect(mocks.reapTempFiles).toHaveBeenCalledWith({ all: true });
    expect(recentPrsMock.clearRecentPrs).toHaveBeenCalledTimes(1);
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('still reaps when the sync-engine memo reset throws', () => {
    mocks.resetArtifactMirrorSyncState.mockImplementationOnce(() => {
      throw new Error('engine memo held');
    });

    expect(() => {
      clearSessionScopedState();
    }).not.toThrow();

    expect(fakeFs.deleted).toEqual([MIRROR_ROOT_URI]);
    expect(mocks.reapTempFiles).toHaveBeenCalledWith({ all: true });
    expect(recentPrsMock.clearRecentPrs).toHaveBeenCalledTimes(1);
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('still clears PR recents and OS search when temp-file cleanup throws', () => {
    mocks.reapTempFiles.mockImplementationOnce(() => {
      throw new Error('temp files unavailable');
    });

    expect(() => {
      clearSessionScopedState();
    }).not.toThrow();

    expect(recentPrsMock.clearRecentPrs).toHaveBeenCalledTimes(1);
    expect(nativeSearchMock.clearSystemSearchIndex).toHaveBeenCalledTimes(1);
  });

  // The goal-disclosure store stays real, like the mirror: this asserts the
  // wiring through the actual in-memory map rather than a spy on its clear.
  it('drops the per-session goal disclosure flag on sign-out', () => {
    setSessionGoalCollapsed('session-scoped-goal', true);
    expect(isSessionGoalCollapsed('session-scoped-goal')).toBe(true);

    clearSessionScopedState();

    expect(isSessionGoalCollapsed('session-scoped-goal')).toBe(false);
  });
});
