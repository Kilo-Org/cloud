import { describe, expect, it } from 'vitest';

import { botAvatarName } from './bot-avatar-options';

describe('botAvatarName', () => {
  it.each([
    ['🤖', 'Robot'],
    ['🐉', 'Dragon'],
    ['🛰️', 'Satellite'],
    ['🌈', 'Rainbow'],
    ['🪄', 'Magic wand'],
    ['👽', 'Explorer'],
    ['🪬', 'Talisman'],
  ])('preserves the supported %s identity as %s', (emoji, name) => {
    expect(botAvatarName(emoji)).toBe(name);
  });

  it('uses a generic accessible name for an unknown legacy identity', () => {
    expect(botAvatarName('unknown')).toBe('Bot');
  });
});
