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
]);

export function botAvatarName(emoji: string): string {
  return AVATAR_NAMES.get(emoji) ?? 'Bot';
}
