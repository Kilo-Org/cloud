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
} from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';

type SettingsItem = {
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
  path: string;
};

const SETTINGS_ITEMS = [
  {
    icon: Sparkles,
    labelKey: 'common.model',
    descriptionKey: 'kiloclaw.settings.modelDescription',
    path: 'settings/model',
  },
  {
    icon: Lock,
    labelKey: 'kiloclaw.secrets.title',
    descriptionKey: 'kiloclaw.settings.secretsDescription',
    path: 'settings/secrets',
  },
  {
    icon: MessageSquare,
    labelKey: 'kiloclaw.channels.title',
    descriptionKey: 'kiloclaw.settings.channelsDescription',
    path: 'settings/channels',
  },
  {
    icon: Link2,
    labelKey: 'kiloclaw.devicePairing.title',
    descriptionKey: 'kiloclaw.settings.devicePairingDescription',
    path: 'settings/device-pairing',
  },
  {
    icon: Shield,
    labelKey: 'kiloclaw.execPolicy.title',
    descriptionKey: 'kiloclaw.settings.execPolicyDescription',
    path: 'settings/exec-policy',
  },
  {
    icon: Pin,
    labelKey: 'kiloclaw.versionPin.title',
    descriptionKey: 'kiloclaw.settings.versionPinDescription',
    path: 'settings/version-pin',
  },
  {
    icon: Mail,
    labelKey: 'kiloclaw.google.title',
    descriptionKey: 'kiloclaw.settings.googleDescription',
    path: 'settings/google',
  },
] as const satisfies readonly SettingsItem[];

export function SettingsList() {
  const router = useRouter();
  const { t } = useTranslation();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card px-4">
      {SETTINGS_ITEMS.map((item, index) => {
        const isLast = index === SETTINGS_ITEMS.length - 1;
        return (
          <ConfigureRow
            key={item.path}
            icon={item.icon}
            title={t(item.labelKey)}
            subtitle={t(item.descriptionKey)}
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
