import { describe, expect, it } from 'vitest';

import {
  groupWorkspaceArtifactsByFolder,
  isSandboxNotRunning,
  type WorkspaceArtifactEntry,
  workspaceArtifactFileName,
} from './session-artifacts-grouping';

/** A saved file as the worker lists it; only the path matters to these helpers. */
function entry(relativePath: string, seed: number): WorkspaceArtifactEntry {
  return {
    relativePath,
    contentHash: seed.toString(16).padStart(64, '0'),
    sizeBytes: seed,
    contentType: 'text/plain',
    updatedAt: 1_767_225_600_000,
  };
}

describe('groupWorkspaceArtifactsByFolder', () => {
  it('groups nested folders by directory and sorts the folders', () => {
    const groups = groupWorkspaceArtifactsByFolder(
      [
        entry('reports/charts/q4/q4.png', 1),
        entry('reports/summary.pdf', 2),
        entry('charts/q4.png', 3),
      ],
      'Artifacts'
    );

    expect(groups.map(group => group.directory)).toEqual([
      'charts',
      'reports',
      'reports/charts/q4',
    ]);
    expect(groups.map(group => group.label)).toEqual(['charts', 'reports', 'reports/charts/q4']);
    expect(groups.map(group => group.files.map(file => file.relativePath))).toEqual([
      ['charts/q4.png'],
      ['reports/summary.pdf'],
      ['reports/charts/q4/q4.png'],
    ]);
  });

  it('sorts the files of one folder by path', () => {
    const groups = groupWorkspaceArtifactsByFolder(
      [entry('reports/zeta.md', 1), entry('reports/alpha.md', 2), entry('reports/middle.md', 3)],
      'Artifacts'
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.files.map(file => file.relativePath)).toEqual([
      'reports/alpha.md',
      'reports/middle.md',
      'reports/zeta.md',
    ]);
  });

  it('keeps files at the root in one group labelled with the caller fallback', () => {
    const groups = groupWorkspaceArtifactsByFolder(
      [entry('readme.md', 1), entry('summary.pdf', 2)],
      'Saved files'
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.directory).toBe('');
    expect(groups[0]?.label).toBe('Saved files');
    expect(groups[0]?.files.map(file => file.relativePath)).toEqual(['readme.md', 'summary.pdf']);
  });

  it('keeps a root file apart from a folder of the same name', () => {
    const groups = groupWorkspaceArtifactsByFolder(
      [entry('reports', 1), entry('reports/summary.pdf', 2)],
      'Artifacts'
    );

    expect(groups.map(group => group.directory)).toEqual(['', 'reports']);
    expect(groups[0]?.label).toBe('Artifacts');
    expect(groups[1]?.label).toBe('reports');
  });

  it('answers no groups for no files', () => {
    expect(groupWorkspaceArtifactsByFolder([], 'Artifacts')).toEqual([]);
  });
});

describe('workspaceArtifactFileName', () => {
  it('takes the last segment of a nested path', () => {
    expect(workspaceArtifactFileName({ relativePath: 'reports/charts/q4/q4.png' })).toBe('q4.png');
  });

  it('keeps a root file name whole', () => {
    expect(workspaceArtifactFileName({ relativePath: 'summary.pdf' })).toBe('summary.pdf');
  });
});

describe('isSandboxNotRunning', () => {
  it.each(['sleeping', 'stopping', 'error'])('reads %s as not running', status => {
    expect(isSandboxNotRunning(status)).toBe(true);
  });

  it.each(['active', 'starting', 'unknown', undefined, null])(
    'reads %s as running or unknown',
    status => {
      expect(isSandboxNotRunning(status)).toBe(false);
    }
  );
});
