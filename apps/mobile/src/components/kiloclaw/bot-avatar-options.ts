const AVATAR_NAMES: ReadonlyMap<string, string> = new Map([
  ['🤖', 'Robot'],
  ['👾', 'Arcade'],
  ['🧠', 'Brain'],
  ['⚡', 'Lightning'],
  ['🔮', 'Crystal'],
  ['🔥', 'Flame'],
  ['🐉', 'Dragon'],
  ['✨', 'Sparkles'],
  ['🌙', 'Moon'],
  ['🐙', 'Creature'],
  ['🌀', 'Orbit'],
  ['🛰️', 'Satellite'],
  ['🌈', 'Rainbow'],
  ['🪄', 'Magic wand'],
  ['👽', 'Explorer'],
  ['🪬', 'Talisman'],
  ['🦾', 'Strong arm'],
  ['⚙️', 'Operator'],
  ['🧿', 'Oracle'],
]);

export function botAvatarName(emoji: string): string {
  return AVATAR_NAMES.get(emoji) ?? 'Custom avatar';
}

export function botAvatarFallbackIndex(value: string, optionCount: number): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash % optionCount;
}
