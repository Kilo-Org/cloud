import { describe, expect, it } from 'vitest';

import { botAvatarFallbackIndex, botAvatarName } from './bot-avatar-options';

describe('botAvatarName', () => {
  it.each([
    ['🤖', 'Robot'],
    ['🐉', 'Dragon'],
    ['🛰️', 'Satellite'],
    ['🌈', 'Rainbow'],
    ['🪄', 'Magic wand'],
    ['👽', 'Explorer'],
    ['🪬', 'Talisman'],
    ['🦾', 'Strong arm'],
    ['⚙️', 'Operator'],
    ['🧿', 'Oracle'],
  ])('preserves the supported %s identity as %s', (emoji, name) => {
    expect(botAvatarName(emoji)).toBe(name);
  });

  it('preserves unknown persisted identities with a distinct fallback', () => {
    expect(botAvatarName('unknown')).toBe('Custom avatar');
    expect(botAvatarFallbackIndex('custom-a', 4)).not.toBe(botAvatarFallbackIndex('custom-b', 4));
  });
});
