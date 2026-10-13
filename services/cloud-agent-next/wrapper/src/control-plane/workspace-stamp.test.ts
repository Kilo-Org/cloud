import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyWorkspace,
  planStamp,
  readWorkspaceStamp,
  snapshotAction,
  SNAPSHOT_MAX_GENERATION,
  SNAPSHOT_REFRESH_AFTER_MS,
  workspaceStampPath,
  writeWorkspaceStamp,
} from './workspace-stamp.js';

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
    await fs.writeFile(file, JSON.stringify({ allocationId: 'a', commit: 'c' }));
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

describe('planning a stamp', () => {
  const now = 10 * SNAPSHOT_REFRESH_AFTER_MS;
  const previous = (age: number, generation: number) => ({
    allocationId: 'before',
    commit: 'c',
    capturedAt: now - age,
    generation,
  });

  it('captures a fresh clone as generation 0 and nothing else a clone did not make', () => {
    expect(planStamp({ cloning: true, adopted: false, previous: null, now })).toEqual({
      lineage: { capturedAt: now, generation: 0 },
      capture: true,
    });
    expect(planStamp({ cloning: false, adopted: false, previous: null, now }).capture).toBe(false);
  });

  it('refreshes an adopted snapshot once it is old enough', () => {
    const plan = planStamp({
      cloning: false,
      adopted: true,
      previous: previous(SNAPSHOT_REFRESH_AFTER_MS, 1),
      now,
    });
    expect(plan).toEqual({ lineage: { capturedAt: now, generation: 2 }, capture: true });
  });

  it('keeps the capture time and generation of a snapshot that is not due', () => {
    const plan = planStamp({
      cloning: false,
      adopted: true,
      previous: previous(SNAPSHOT_REFRESH_AFTER_MS - 1, 1),
      now,
    });
    expect(plan).toEqual({
      lineage: { capturedAt: now - SNAPSHOT_REFRESH_AFTER_MS + 1, generation: 1 },
      capture: false,
    });
  });

  it('rebuilds instead of refreshing once a due snapshot is at the generation cap', () => {
    const due = (generation: number) =>
      snapshotAction(previous(SNAPSHOT_REFRESH_AFTER_MS, generation), now);
    expect(due(SNAPSHOT_MAX_GENERATION - 1)).toBe('refresh');
    expect(due(SNAPSHOT_MAX_GENERATION)).toBe('rebuild');
    expect(
      snapshotAction(previous(SNAPSHOT_REFRESH_AFTER_MS - 1, SNAPSHOT_MAX_GENERATION), now)
    ).toBe('keep');
  });
});
