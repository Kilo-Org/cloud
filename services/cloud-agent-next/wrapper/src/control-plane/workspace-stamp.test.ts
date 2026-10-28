import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyWorkspace,
  readWorkspaceStamp,
  workspaceStampPath,
  writeWorkspaceStamp,
} from './workspace-stamp.js';

// Lineage that wrappers which captured session snapshots wrote; still readable.
const LINEAGE = { capturedAt: 1_000, generation: 0 };

let root: string;
let directory: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'stamp-'));
  directory = path.join(root, 'app');
  await fs.mkdir(path.join(directory, '.git'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('workspace stamp', () => {
  it('lives inside .git for a repository and beside the directory otherwise', () => {
    expect(workspaceStampPath('/workspace/app', true)).toBe(
      '/workspace/app/.git/kilo-workspace.json'
    );
    expect(workspaceStampPath('/workspace/app', false)).toBe('/workspace/app.kilo-workspace.json');
  });

  it('round-trips the current shape without lineage', async () => {
    await writeWorkspaceStamp(directory, true, { allocationId: 'builder', commit: 'c1' });
    expect(await readWorkspaceStamp(directory, true)).toEqual({
      allocationId: 'builder',
      commit: 'c1',
    });
  });

  it('round-trips and replaces without leaving a temporary file', async () => {
    await writeWorkspaceStamp(directory, true, { ...LINEAGE, allocationId: 'a', commit: 'c1' });
    await writeWorkspaceStamp(directory, true, { ...LINEAGE, allocationId: 'b', commit: 'c2' });

    expect(await readWorkspaceStamp(directory, true)).toEqual({
      ...LINEAGE,
      allocationId: 'b',
      commit: 'c2',
    });
    expect(await fs.readdir(path.join(directory, '.git'))).toEqual(['kilo-workspace.json']);
  });

  it('reads a missing, corrupt or foreign-shaped stamp as none', async () => {
    expect(await readWorkspaceStamp(directory, true)).toBeNull();
    const file = workspaceStampPath(directory, true);
    await fs.writeFile(file, 'not json');
    expect(await readWorkspaceStamp(directory, true)).toBeNull();
    await fs.writeFile(
      file,
      JSON.stringify({ ...LINEAGE, allocationId: 'a', commit: 'c', extra: 1 })
    );
    expect(await readWorkspaceStamp(directory, true)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ allocationId: 'a' }));
    expect(await readWorkspaceStamp(directory, true)).toBeNull();
    await fs.writeFile(file, 'ready\n');
    expect(await readWorkspaceStamp(directory, true)).toBeNull();
  });

  it('classifies a workspace from the filesystem alone', () => {
    const mine = { ...LINEAGE, allocationId: 'now', commit: 'c' };
    const other = { ...LINEAGE, allocationId: 'before', commit: 'c' };
    const input = { allocationId: 'now' };
    expect(classifyWorkspace({ ...input, hasGit: false, stamp: null })).toBe('empty');
    expect(classifyWorkspace({ ...input, hasGit: true, stamp: null })).toBe('unstamped');
    expect(classifyWorkspace({ ...input, hasGit: true, stamp: mine })).toBe('same');
    expect(classifyWorkspace({ ...input, hasGit: false, stamp: mine })).toBe('same');
    expect(classifyWorkspace({ ...input, hasGit: true, stamp: other })).toBe('foreign');
    expect(classifyWorkspace({ ...input, hasGit: false, stamp: other })).toBe('empty');
  });
});
