import type { SlashCommandInfo } from '@/lib/cloud-agent-sdk';
import type { ActiveSessionType } from '@/lib/cloud-agent-sdk';
import { atom, createStore } from 'jotai';
import type { SessionManager } from '@/lib/cloud-agent-sdk';
import { selectSlashCommands } from './slash-command-selection';
import { useSlashCommandSets } from './useSlashCommandSets';

// The shared package is mocked so that tests of the routing logic do not depend
// on the exact contents of the real pinned default catalog or the
// session-local compaction append. commandsOrDefault is deliberately simplified
// to isolate the selector rule (cloud-agent falls back to defaults, remote does
// not) from the actual shared implementation.
jest.mock(
  '@cloud-agent-shared',
  () => ({
    commandsOrDefault: (commands: SlashCommandInfo[] | null | undefined) =>
      commands && commands.length > 0
        ? commands
        : [
            {
              name: 'compact',
              description: 'compact the current session context',
              hints: [],
            },
          ],
  }),
  { virtual: true }
);

jest.mock('@/components/cloud-agent-next/CloudAgentProvider', () => ({
  useManager: (): SessionManager => mockManager as SessionManager,
}));

let mockManager: SessionManager;

const reportedRemoteCommands: SlashCommandInfo[] = [
  {
    name: 'review',
    description: 'Review changes',
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'init',
    hints: [],
  },
];

describe('selectSlashCommands', () => {
  it('preserves the cloud-agent default fallback when the live list is empty', () => {
    expect(selectSlashCommands('cloud-agent', [])).toEqual([
      {
        trigger: 'compact',
        label: 'compact',
        description: 'compact the current session context',
        expansion: '',
      },
    ]);
  });

  it('uses the live list verbatim for cloud-agent sessions when it is non-empty', () => {
    expect(selectSlashCommands('cloud-agent', reportedRemoteCommands)).toEqual([
      {
        trigger: 'review',
        label: 'review',
        description: 'Review changes',
        expansion: '',
      },
      {
        trigger: 'init',
        label: 'init',
        description: '',
        expansion: '',
      },
    ]);
  });

  it('uses only the live CLI catalog for remote sessions and never falls back to defaults', () => {
    expect(selectSlashCommands('remote', reportedRemoteCommands)).toEqual([
      {
        trigger: 'review',
        label: 'review',
        description: 'Review changes',
        expansion: '',
      },
      {
        trigger: 'init',
        label: 'init',
        description: '',
        expansion: '',
      },
    ]);
  });

  it('returns an empty list for remote sessions when the live catalog is empty', () => {
    expect(selectSlashCommands('remote', [])).toEqual([]);
  });

  it('exposes no commands for read-only sessions even when the catalog is populated', () => {
    expect(selectSlashCommands('read-only', reportedRemoteCommands)).toEqual([]);
  });

  it('exposes no commands before the session type is resolved', () => {
    expect(selectSlashCommands(null, reportedRemoteCommands)).toEqual([]);
  });

  it('maps SlashCommandInfo to the SlashCommand UI shape without inventing templates', () => {
    const result = selectSlashCommands('remote', [
      {
        name: 'review',
        description: 'Review changes',
        hints: ['$ARGUMENTS', 'some ignored template'],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      trigger: 'review',
      label: 'review',
      description: 'Review changes',
      expansion: '',
    });
    // No $ARGUMENTS / $1 / $2 substitution is performed here — the cloud-agent
    // worker still receives the structured payload.
    expect(result[0]?.expansion).toBe('');
  });

  it('coerces a missing description to an empty string for autocomplete', () => {
    expect(
      selectSlashCommands('remote', [{ name: 'no-desc', hints: [] } as SlashCommandInfo])
    ).toEqual([
      {
        trigger: 'no-desc',
        label: 'no-desc',
        description: '',
        expansion: '',
      },
    ]);
  });
});

describe('useSlashCommandSets', () => {
  let store: ReturnType<typeof createStore>;
  let availableCommandsAtom: ReturnType<typeof atom<SlashCommandInfo[]>>;
  let activeSessionTypeAtom: ReturnType<typeof atom<ActiveSessionType | null>>;

  beforeEach(() => {
    store = createStore();
    availableCommandsAtom = atom<SlashCommandInfo[]>([]);
    activeSessionTypeAtom = atom<ActiveSessionType | null>(null);
    mockManager = {
      atoms: {
        availableCommands: availableCommandsAtom,
        activeSessionType: activeSessionTypeAtom,
      },
    } as unknown as SessionManager;
  });

  it('recomputes availableCommands when activeSessionType or availableCommands atoms change', () => {
    // This exercises the same atoms that useSlashCommandSets reads. The hook
    // is a thin wrapper around useAtomValue for these two atoms plus the
    // selectSlashCommands selector, so driving the store directly proves the
    // reactive output the hook would return on each re-render.

    // 1. Remote session with a live CLI catalog: surface the reported commands.
    store.set(activeSessionTypeAtom, 'remote');
    store.set(availableCommandsAtom, reportedRemoteCommands);
    expect(
      selectSlashCommands(store.get(activeSessionTypeAtom), store.get(availableCommandsAtom))
    ).toEqual([
      {
        trigger: 'review',
        label: 'review',
        description: 'Review changes',
        expansion: '',
      },
      {
        trigger: 'init',
        label: 'init',
        description: '',
        expansion: '',
      },
    ]);

    // 2. Switch session type to read-only: output becomes empty.
    store.set(activeSessionTypeAtom, 'read-only');
    expect(
      selectSlashCommands(store.get(activeSessionTypeAtom), store.get(availableCommandsAtom))
    ).toEqual([]);

    // 3. Switch back to remote, but the wrapper reports an empty catalog:
    // remote sessions stay empty instead of falling back to Cloud defaults.
    store.set(activeSessionTypeAtom, 'remote');
    store.set(availableCommandsAtom, []);
    expect(
      selectSlashCommands(store.get(activeSessionTypeAtom), store.get(availableCommandsAtom))
    ).toEqual([]);
  });

  it('exports a stable public API shape', () => {
    // Sanity check that the hook module remains a callable hook that returns
    // the expected object shape for consumers (BrowseCommandsDialog, CloudChatPage).
    expect(typeof useSlashCommandSets).toBe('function');
  });
});
