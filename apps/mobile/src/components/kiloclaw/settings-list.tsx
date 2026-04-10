import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronRight,
  Lock,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Pin,
  Shield,
  Sparkles,
} from 'lucide-react-native';
import type React from 'react';
import { Pressable, View } from 'react-native';

import { GoogleIcon } from '@/components/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SettingsItem = {
  icon: LucideIcon | React.ComponentType<{ size?: number; color?: string }>;
  iconColor: string;
  label: string;
  description: string;
  path: string;
};

const SETTINGS_ITEMS: SettingsItem[] = [
  {
    icon: Sparkles,
    iconColor: '#a855f7',
    label: 'Model',
    description: 'AI model selection',
    path: 'settings/model',
  },
  {
    icon: Lock,
    iconColor: '#f59e0b',
    label: 'Secrets',
    description: 'Encrypted credentials',
    path: 'settings/secrets',
  },
  {
    icon: MessageSquare,
    iconColor: '#3b82f6',
    label: 'Channels',
    description: 'Telegram, Discord, Slack, GitHub',
    path: 'settings/channels',
  },
  {
    icon: Monitor,
    iconColor: '#06b6d4',
    label: 'Device Pairing',
    description: 'Approve device requests',
    path: 'settings/device-pairing',
  },
  {
    icon: Shield,
    iconColor: '#10b981',
    label: 'Execution Policy',
    description: 'Security settings',
    path: 'settings/exec-policy',
  },
  {
    icon: Pin,
    iconColor: '#8b5cf6',
    label: 'Version Pinning',
    description: 'Pin to a specific version',
    path: 'settings/version-pin',
  },
  {
    icon: GoogleIcon,
    iconColor: '#ef4444',
    label: 'Google Account',
    description: 'Gmail, Calendar, Docs',
    path: 'settings/google',
  },
];

export function SettingsList() {
  const router = useRouter();
  const colors = useThemeColors();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  return (
    <View className="rounded-lg bg-secondary overflow-hidden">
      {SETTINGS_ITEMS.map((item, index) => {
        const Icon = item.icon;
        const isLast = index === SETTINGS_ITEMS.length - 1;

        return (
          <View key={item.path}>
            <Pressable
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              onPress={() => {
                router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/${item.path}` as Href);
              }}
              accessibilityLabel={item.label}
            >
              <Icon size={18} color={item.iconColor} />
              <View className="flex-1">
                <Text className="text-sm font-medium">{item.label}</Text>
                <Text className="text-xs text-muted-foreground">{item.description}</Text>
              </View>
              <ChevronRight size={16} color={colors.mutedForeground} />
            </Pressable>
            {!isLast && <View className="ml-14 h-px bg-border" />}
          </View>
        );
      })}
    </View>
  );
}
