import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BranchPickerBridge,
  type FolderPickerBridge,
  type ModePickerBridge,
  type RepoPickerBridge,
} from '@/lib/picker-bridge';

import { agentChatPickerFixtureRoute } from './agent-chat-picker-fixture';

const slots = vi.hoisted(() => ({
  branch: vi.fn((_key: string, _bridge: BranchPickerBridge) => undefined),
  folder: vi.fn((_key: string, _bridge: FolderPickerBridge) => undefined),
  mode: vi.fn((_key: string, _bridge: ModePickerBridge) => undefined),
  repo: vi.fn((_key: string, _bridge: RepoPickerBridge) => undefined),
}));

vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  branchPickerSlot: { set: slots.branch },
  folderPickerSlot: { set: slots.folder },
  modePickerSlot: { set: slots.mode },
  repoPickerSlot: { set: slots.repo },
}));

beforeEach(() => {
  for (const slot of Object.values(slots)) {
    slot.mockReset();
  }
});

describe('agentChatPickerFixtureRoute', () => {
  it('opens the branch sheet with each list', () => {
    expect(agentChatPickerFixtureRoute('/dev/branch-picker-fixture/listed')).toBe(
      '/(app)/agent-chat/branch-picker'
    );
    expect(slots.branch.mock.calls[0]?.[1]).toMatchObject({
      branches: ['main', 'develop', 'release/2026-11'],
      defaultBranch: 'main',
      truncated: false,
    });
    agentChatPickerFixtureRoute('/dev/branch-picker-fixture/long');
    expect(slots.branch.mock.calls[1]?.[1].branches).toHaveLength(41);
    agentChatPickerFixtureRoute('/dev/branch-picker-fixture/truncated');
    expect(slots.branch.mock.calls[2]?.[1]).toMatchObject({ truncated: true });
  });

  it('adds custom modes only for the custom state', () => {
    expect(agentChatPickerFixtureRoute('/dev/mode-picker-fixture/builtin')).toBe(
      '/(app)/agent-chat/mode-picker'
    );
    expect(slots.mode.mock.calls[0]?.[1]).toMatchObject({ customOptions: undefined });
    agentChatPickerFixtureRoute('/dev/mode-picker-fixture/custom');
    expect(slots.mode.mock.calls[1]?.[1].customOptions).toHaveLength(2);
  });

  it('opens the repository sheet with rows, none, or many', () => {
    expect(agentChatPickerFixtureRoute('/dev/repo-picker-fixture/listed')).toBe(
      '/(app)/agent-chat/repo-picker'
    );
    const listed = slots.repo.mock.calls[0]?.[1];
    expect(listed?.repositories).toHaveLength(6);
    expect(listed?.sections.map(section => section.key)).toEqual(['recents', 'github', 'gitlab']);
    expect(listed?.currentValue).toBe('kilo-org/repo-1');

    agentChatPickerFixtureRoute('/dev/repo-picker-fixture/empty');
    expect(slots.repo.mock.calls[1]?.[1]).toMatchObject({
      repositories: [],
      sections: [],
      currentValue: '',
    });

    agentChatPickerFixtureRoute('/dev/repo-picker-fixture/long');
    expect(slots.repo.mock.calls[2]?.[1].repositories).toHaveLength(40);
  });

  it('opens the folder sheet on the connection the link names', () => {
    expect(
      agentChatPickerFixtureRoute('/dev/folder-picker-fixture?connection=conn-1&project=proj')
    ).toBe('/(app)/agent-chat/folder-picker');
    expect(slots.folder.mock.calls[0]?.[1]).toMatchObject({
      connectionId: 'conn-1',
      projectName: 'proj',
      currentPath: '',
    });
  });

  it('ignores unknown states and other paths', () => {
    expect(agentChatPickerFixtureRoute('/dev/branch-picker-fixture/other')).toBeNull();
    expect(agentChatPickerFixtureRoute('/dev/repo-picker-fixture')).toBeNull();
    expect(agentChatPickerFixtureRoute('/dev/folder-picker-fixture/listed')).toBeNull();
    expect(agentChatPickerFixtureRoute('/dev/instance-picker-fixture/cloud')).toBeNull();
    for (const slot of Object.values(slots)) {
      expect(slot).not.toHaveBeenCalled();
    }
  });
});
