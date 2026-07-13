import {
  Bot,
  Brain,
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
  Sparkles,
  Telescope,
  WandSparkles,
  Workflow,
  Zap,
} from 'lucide-react-native';

type Avatar = { Icon: LucideIcon };

const DEFAULT_AVATAR: Avatar = { Icon: Bot };
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
]);

type BotAvatarProps = {
  emoji: string;
  color: string;
  size: number;
};

export function BotAvatar({ emoji, color, size }: Readonly<BotAvatarProps>) {
  const { Icon } = AVATARS.get(emoji) ?? DEFAULT_AVATAR;
  return <Icon size={size} color={color} />;
}
