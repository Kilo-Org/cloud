import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Bot } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type AgentsPromoCardProps = {
  organizationId: string | null;
};

export function AgentsPromoCard({ organizationId }: Readonly<AgentsPromoCardProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const title = t('home.kiloAgents');
  const tint = agentColor('Kilo Agents');

  return (
    <Pressable
      onPress={() => {
        const path = organizationId
          ? `/(app)/agent-chat/new?organizationId=${organizationId}`
          : '/(app)/agent-chat/new';
        router.push(path as Href);
      }}
      className="mx-4 gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
      accessibilityLabel={t('home.startNewAgentSession')}
    >
      <View className="flex-row items-start gap-3">
        <View
          className={cn(
            'h-10 w-10 items-center justify-center rounded-[10px] border',
            tint.tileBgClass,
            tint.tileBorderClass
          )}
        >
          <Bot size={18} color={colors[tint.hueThemeKey]} />
        </View>
        <View className="flex-1">
          <Text className="text-[17px] font-semibold text-foreground">{title}</Text>
          <Text variant="muted" className="mt-0.5 text-[13px]">
            {t('home.aiCodingSessions')}
          </Text>
        </View>
      </View>
      <Text variant="muted" className="text-[14px] leading-5">
        {t('home.startCodingTaskFromPhone')}
      </Text>
      <View className="flex-row items-center justify-between">
        <Text className="font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
          {t('home.tryIt')}
        </Text>
        <DirectionalChevronRight size={16} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}
