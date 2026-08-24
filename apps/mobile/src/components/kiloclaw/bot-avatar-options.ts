import { i18n } from '@/i18n';

const AVATAR_NAMES = {
  '🤖': 'kiloclaw.avatar.robot',
  '👾': 'kiloclaw.avatar.arcade',
  '🧠': 'kiloclaw.avatar.brain',
  '⚡': 'kiloclaw.avatar.lightning',
  '🔮': 'kiloclaw.avatar.crystal',
  '🔥': 'kiloclaw.avatar.flame',
  '🐉': 'kiloclaw.avatar.dragon',
  '✨': 'kiloclaw.avatar.sparkles',
  '🌙': 'kiloclaw.avatar.moon',
  '🐙': 'kiloclaw.avatar.creature',
  '🌀': 'kiloclaw.avatar.orbit',
  '🛰️': 'kiloclaw.avatar.satellite',
  '🌈': 'kiloclaw.avatar.rainbow',
  '🪄': 'kiloclaw.avatar.magicWand',
  '👽': 'kiloclaw.avatar.explorer',
  '🪬': 'kiloclaw.avatar.talisman',
  '🦾': 'kiloclaw.avatar.strongArm',
  '⚙️': 'kiloclaw.avatar.operator',
  '🧿': 'kiloclaw.avatar.oracle',
} as const;

export function botAvatarName(emoji: string): string {
  return i18n.t(
    Object.hasOwn(AVATAR_NAMES, emoji)
      ? AVATAR_NAMES[emoji as keyof typeof AVATAR_NAMES]
      : 'kiloclaw.avatar.custom'
  );
}

export function botAvatarFallbackIndex(value: string, optionCount: number): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash % optionCount;
}
