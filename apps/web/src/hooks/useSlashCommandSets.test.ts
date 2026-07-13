import { selectSlashCommands } from './slash-command-selection';

jest.mock(
  '@cloud-agent-shared',
  () => ({
    commandsOrDefault: (commands: typeof reportedCommands) =>
      commands.length > 0 ? commands : [{ name: 'compact', hints: [] }],
  }),
  { virtual: true }
);

const reportedCommands = [{ name: 'review', description: 'Review changes', hints: ['$ARGUMENTS'] }];

describe('selectSlashCommands', () => {
  it('uses only the reported catalog for remote sessions', () => {
    expect(selectSlashCommands('remote', reportedCommands)).toEqual([
      {
        trigger: 'review',
        label: 'review',
        description: 'Review changes',
        expansion: '',
      },
    ]);
    expect(selectSlashCommands('remote', [])).toEqual([]);
  });

  it('keeps Cloud Agent defaults while its reported catalog is unavailable', () => {
    expect(selectSlashCommands('cloud-agent', [])).toEqual([
      {
        trigger: 'compact',
        label: 'compact',
        description: '',
        expansion: '',
      },
    ]);
  });

  it('exposes no commands before resolution or for read-only sessions', () => {
    expect(selectSlashCommands(null, reportedCommands)).toEqual([]);
    expect(selectSlashCommands('read-only', reportedCommands)).toEqual([]);
  });
});
