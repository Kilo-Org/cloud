import type { SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { selectSlashCommands } from './slash-command-selection';

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
