import type { CommandSet, SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { selectBrowseCommandSets } from './browse-command-sets';

const explicitCommands: SlashCommand[] = [
  { trigger: 'review', label: 'review', description: 'Review changes', expansion: '' },
  { trigger: 'custom', label: 'custom', description: 'Custom profile command', expansion: '' },
];

const hookSets: CommandSet[] = [
  {
    id: 'kilo',
    name: 'Kilo',
    description: 'Project and MCP commands available in this session',
    prefix: '',
    commands: [{ trigger: 'default', label: 'default', description: 'Default', expansion: '' }],
  },
];

describe('selectBrowseCommandSets', () => {
  it('uses exactly the explicit commands when provided, overriding hook sets', () => {
    const result = selectBrowseCommandSets(hookSets, explicitCommands);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'kilo',
      name: 'Kilo',
      description: 'Project and MCP commands available in this session',
      prefix: '',
    });
    expect(result[0].commands).toEqual(explicitCommands);
    expect(result[0].commands).not.toEqual(hookSets[0].commands);
  });

  it('uses hook sets when no explicit commands are supplied', () => {
    const result = selectBrowseCommandSets(hookSets, undefined);
    expect(result).toEqual(hookSets);
  });

  it('preserves an empty explicit command list exactly instead of falling back to hook sets', () => {
    const result = selectBrowseCommandSets(hookSets, []);
    expect(result).toHaveLength(1);
    expect(result[0].commands).toEqual([]);
  });
});
