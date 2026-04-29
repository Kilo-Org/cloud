import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Link2,
  Lock,
  type LucideIcon,
  Mail,
  MessageSquare,
  Pin,
  Shield,
  Sparkles,
} from 'lucide-react-native';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';

type SettingsItem = {
  icon: LucideIcon;
  label: string;
  description: string;
  path: string;
};

const SETTINGS_ITEMS: SettingsItem[] = [
  {
    icon: Sparkles,
    label: 'Model',
    description: 'AI model selection',
    path: 'settings/model',
  },
  {
    icon: Lock,
    label: 'Secrets',
    description: 'Encrypted credentials',
    path: 'settings/secrets',
  },
  {
    icon: MessageSquare,
    label: 'Channels',
    description: 'Telegram, Discord, Slack, GitHub',
    path: 'settings/channels',
  },
  {
    icon: Link2,
    label: 'Device Pairing',
    description: 'Approve device requests',
    path: 'settings/device-pairing',
  },
  {
    icon: Shield,
    label: 'Execution Policy',
    description: 'Security settings',
    path: 'settings/exec-policy',
  },
  {
    icon: Pin,
    label: 'Version Pinning',
    description: 'Pin to a specific version',
    path: 'settings/version-pin',
  },
  {
    icon: Mail,
    label: 'Google Account',
    description: 'Gmail, Calendar, Docs',
    path: 'settings/google',
  },
];

export function SettingsList() {
  const router = useRouter();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card px-4">
      {SETTINGS_ITEMS.map((item, index) => {
        const isLast = index === SETTINGS_ITEMS.length - 1;
        return (
          <ConfigureRow
            key={item.path}
            icon={item.icon}
            title={item.label}
            subtitle={item.description}
            last={isLast}
            onPress={() => {
              router.push(`/(app)/kiloclaw/${instanceId}/${item.path}` as Href);
            }}
          />
        );
      })}
    </View>
  );
}
