import {
  Bot,
  Brain,
  CircleDot,
  Dumbbell,
  Eye,
  Flame,
  FlameKindling,
  Gamepad2,
  Gem,
  type LucideIcon,
  Moon,
  Orbit,
  Rainbow,
  Satellite,
  ScanEye,
  Settings,
  Shapes,
  Sparkles,
  Telescope,
  WandSparkles,
  Workflow,
  Zap,
} from 'lucide-react-native';

import { botAvatarFallbackIndex } from '@/components/kiloclaw/bot-avatar-options';

type Avatar = { Icon: LucideIcon };

const DEFAULT_AVATAR: Avatar = { Icon: Bot };
const FALLBACK_AVATARS: readonly Avatar[] = [
  { Icon: CircleDot },
  { Icon: Orbit },
  { Icon: Shapes },
  { Icon: Sparkles },
];
const AVATARS: ReadonlyMap<string, Avatar> = new Map([
  ['🤖', DEFAULT_AVATAR],
  ['👾', { Icon: Gamepad2 }],
  ['🧠', { Icon: Brain }],
  ['⚡', { Icon: Zap }],
  ['🔮', { Icon: Gem }],
  ['🔥', { Icon: Flame }],
  ['🐉', { Icon: FlameKindling }],
  ['✨', { Icon: Sparkles }],
  ['🌙', { Icon: Moon }],
  ['🐙', { Icon: Workflow }],
  ['🌀', { Icon: Orbit }],
  ['🛰️', { Icon: Satellite }],
  ['🌈', { Icon: Rainbow }],
  ['🪄', { Icon: WandSparkles }],
  ['👽', { Icon: Telescope }],
  ['🪬', { Icon: Eye }],
  ['🦾', { Icon: Dumbbell }],
  ['⚙️', { Icon: Settings }],
  ['🧿', { Icon: ScanEye }],
]);

type BotAvatarProps = {
  emoji: string;
  color: string;
  size: number;
};

export function BotAvatar({ emoji, color, size }: Readonly<BotAvatarProps>) {
  const fallback = FALLBACK_AVATARS[botAvatarFallbackIndex(emoji, FALLBACK_AVATARS.length)];
  const { Icon } = AVATARS.get(emoji) ?? fallback ?? DEFAULT_AVATAR;
  return <Icon size={size} color={color} />;
}
