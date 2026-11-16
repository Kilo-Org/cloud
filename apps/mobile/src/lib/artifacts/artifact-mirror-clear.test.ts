/* eslint-disable import/first -- vi.mock is hoisted above the real import */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureTelemetry: vi.fn(),
  deleteRoot: vi.fn<() => void>(),
}));

vi.mock('@/lib/telemetry/error-sink', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));
// Android resolves the mirror root from the documents directory alone.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-file-system', () => ({
  Directory: vi.fn(function DirectoryMock() {
    return { exists: true, delete: mocks.deleteRoot };
  }),
  File: vi.fn(),
  Paths: { appleSharedContainers: {}, document: 'file:///documents' },
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({
  extensionForMime: () => 'bin',
}));

import { clearArtifactMirror } from './artifact-mirror';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clearArtifactMirror reporting', () => {
  it('reports a delete the container refused', () => {
    const failure = new Error('The mirror container refused the delete.');
    mocks.deleteRoot.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => {
      clearArtifactMirror();
    }).not.toThrow();

    expect(mocks.captureTelemetry).toHaveBeenCalledExactlyOnceWith({
      error: failure,
      level: 'warning',
      tags: { 'error.subsystem': 'artifact-mirror', 'error.operation': 'clear' },
    });
  });

  it('reports nothing when the container answers', () => {
    clearArtifactMirror();

    expect(mocks.deleteRoot).toHaveBeenCalledTimes(1);
    expect(mocks.captureTelemetry).not.toHaveBeenCalled();
  });
});
