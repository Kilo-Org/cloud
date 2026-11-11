import { describe, expect, it } from '@jest/globals';
import {
  formatWorkspaceArtifactSize,
  groupWorkspaceArtifactsByFolder,
  isSandboxNotRunning,
  workspaceArtifactExpiresAt,
  workspaceArtifactFileName,
} from './workspace-artifacts';
import type { WorkspaceArtifactEntry } from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';

function entry(relativePath: string, updatedAt = 1_000): WorkspaceArtifactEntry {
  return {
    relativePath,
    contentHash: 'a'.repeat(64),
    sizeBytes: 1_024,
    contentType: 'application/octet-stream',
    updatedAt,
  };
}

describe('workspace artifact presentation', () => {
  it('groups files by folder and sorts folders and files', () => {
    const groups = groupWorkspaceArtifactsByFolder([
      entry('reports/z.pdf'),
      entry('screenshots/b.png'),
      entry('reports/a.pdf'),
      entry('top.txt'),
    ]);
    expect(groups.map(group => group.label)).toEqual(['Artifacts', 'reports', 'screenshots']);
    expect(groups[0].files.map(file => file.relativePath)).toEqual(['top.txt']);
    expect(groups[1].files.map(file => file.relativePath)).toEqual([
      'reports/a.pdf',
      'reports/z.pdf',
    ]);
  });

  it('expires fourteen days after the last update', () => {
    expect(workspaceArtifactExpiresAt({ updatedAt: 1_000 })).toBe(
      1_000 + 14 * 24 * 60 * 60 * 1_000
    );
    expect(workspaceArtifactExpiresAt({ updatedAt: 1_000, expiresAt: 5_000 })).toBe(5_000);
  });

  it('derives the file name from the relative path', () => {
    expect(workspaceArtifactFileName(entry('reports/weekly.pdf'))).toBe('weekly.pdf');
    expect(workspaceArtifactFileName(entry('top.txt'))).toBe('top.txt');
  });

  it('formats sizes for the artifact list', () => {
    expect(formatWorkspaceArtifactSize(512)).toBe('512 B');
    expect(formatWorkspaceArtifactSize(1_024)).toBe('1 KB');
    expect(formatWorkspaceArtifactSize(1_572_864)).toBe('1.5 MB');
  });

  it('shows the offline notice only for statuses where the sandbox is not running', () => {
    for (const status of ['sleeping', 'stopping', 'error']) {
      expect(isSandboxNotRunning(status)).toBe(true);
    }
    for (const status of ['active', 'starting', 'unreachable', 'unknown', null, undefined]) {
      expect(isSandboxNotRunning(status)).toBe(false);
    }
  });
});
