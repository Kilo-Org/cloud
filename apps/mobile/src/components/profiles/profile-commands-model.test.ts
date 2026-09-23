import { describe, expect, it } from 'vitest';

import {
  addCommand,
  commandRowA11yLabel,
  MAX_SETUP_COMMANDS,
  moveCommand,
  removeCommand,
  replaceCommand,
} from '@/components/profiles/profile-commands-model';

describe('setup command list operations', () => {
  const commands = ['pnpm install', 'pnpm build', 'pnpm test'];

  it('appends a blank command to an empty and a populated list', () => {
    expect(addCommand(commands)).toEqual(['pnpm install', 'pnpm build', 'pnpm test', '']);
    expect(addCommand([])).toEqual(['']);
  });

  it('refuses a command beyond the server list cap', () => {
    const atCap = Array.from({ length: MAX_SETUP_COMMANDS }, (_, index) => `cmd ${index}`);
    expect(addCommand(atCap)).toEqual(atCap);
  });

  it('replaces the command at an index', () => {
    expect(replaceCommand(commands, 1, 'pnpm lint')).toEqual([
      'pnpm install',
      'pnpm lint',
      'pnpm test',
    ]);
    expect(replaceCommand(commands, 7, 'ignored')).toEqual(commands);
  });

  it('removes the command at an index without touching the source list', () => {
    expect(removeCommand(commands, 0)).toEqual(['pnpm build', 'pnpm test']);
    expect(removeCommand(commands, 7)).toEqual(commands);
    expect(commands).toEqual(['pnpm install', 'pnpm build', 'pnpm test']);
  });

  it('moves a command up and down', () => {
    expect(moveCommand(commands, 2, -1)).toEqual(['pnpm install', 'pnpm test', 'pnpm build']);
    expect(moveCommand(commands, 0, 1)).toEqual(['pnpm build', 'pnpm install', 'pnpm test']);
  });

  it('clamps a move at both edges', () => {
    expect(moveCommand(commands, 0, -1)).toEqual(commands);
    expect(moveCommand(commands, 2, 1)).toEqual(commands);
    expect(moveCommand(commands, 5, -1)).toEqual(commands);
  });

  it('clamps a single-command list in both directions', () => {
    const single = ['pnpm install'];
    expect(moveCommand(single, 0, -1)).toEqual(single);
    expect(moveCommand(single, 0, 1)).toEqual(single);
  });
});

describe('commandRowA11yLabel', () => {
  it('labels a row with its 1-based position and the list length', () => {
    expect(commandRowA11yLabel(0, 1)).toBe('1 / 1');
    expect(commandRowA11yLabel(2, 3)).toBe('3 / 3');
  });
});
