import { describe, expect, it } from '@jest/globals';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';
import { getSmartFolderToggle } from './sidebar-settings';

function folder(overrides: Partial<WorkspaceFolder> = {}): WorkspaceFolder {
  return {
    id: 'folder_1',
    name: 'Needs you',
    color: 'orange',
    kind: 'smart',
    smartPreset: 'needs_you',
    sortMode: 'manual',
    worktreeIds: [],
    ...overrides,
  };
}

describe('getSmartFolderToggle', () => {
  it('creates a missing smart folder with its preset and never duplicates it', () => {
    expect(getSmartFolderToggle([], 'needs_you', true)).toEqual({
      action: 'create',
      definition: expect.objectContaining({ preset: 'needs_you', color: 'orange' }),
    });
    expect(getSmartFolderToggle([folder()], 'needs_you', true)).toBeNull();
  });

  it('removes the existing smart folder and ignores a disabled missing one', () => {
    expect(getSmartFolderToggle([folder()], 'needs_you', false)).toEqual({
      action: 'delete',
      folderId: 'folder_1',
    });
    expect(getSmartFolderToggle([], 'needs_you', false)).toBeNull();
  });

  it('does not treat a manual folder with the same name as the smart folder', () => {
    expect(
      getSmartFolderToggle(
        [folder({ kind: 'manual', smartPreset: null, name: 'Needs you' })],
        'needs_you',
        true
      )
    ).toEqual({
      action: 'create',
      definition: expect.objectContaining({ preset: 'needs_you' }),
    });
  });
});
