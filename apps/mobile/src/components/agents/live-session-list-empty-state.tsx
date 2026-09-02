import { type Href, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type LiveSessionListEmptyStateProps = {
  organizationId: string | null;
  tabBarHeight: number;
};

export function LiveSessionListEmptyState({
  organizationId,
  tabBarHeight,
}: Readonly<LiveSessionListEmptyStateProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const [emptyBodyY, setEmptyBodyY] = useState(0);
  const emptyStateSpacerStyle = useMemo(
    () => ({ height: tabBarHeight + Math.max(0, emptyBodyY - top) }),
    [emptyBodyY, tabBarHeight, top]
  );

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="grow justify-center py-4"
      onLayout={event => {
        setEmptyBodyY(event.nativeEvent.layout.y);
      }}
    >
      <EmptyState
        placement="top"
        className="shrink-0 pt-0"
        icon={Bot}
        title={t('home.noLiveSessions')}
        description={t('agents.sessionList.noSessionsYetDescription')}
        action={
          <Button
            variant="outline"
            className="max-w-full"
            accessibilityLabel={t('home.newCodingTask')}
            onPress={() => {
              router.push(getNewAgentSessionPath(organizationId) as Href);
            }}
          >
            <Plus size={16} color={colors.foreground} />
            <Text className="shrink text-center">{t('home.newCodingTask')}</Text>
          </Button>
        }
      />
      <View className="shrink-0" style={emptyStateSpacerStyle} pointerEvents="none" />
    </ScrollView>
  );
}
