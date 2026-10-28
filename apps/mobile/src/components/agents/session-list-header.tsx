import { type ReactNode, useMemo } from 'react';
import { type Href } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { ContextControl } from '@/components/context-control';
import { ScreenHeader } from '@/components/screen-header';
import { IconButton } from '@/components/ui/icon-button';
import { Search } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionListHeaderProps = {
  title: string;
  tabHeader?: ReactNode;
  headerAction?: ReactNode;
  showBackButton?: boolean;
  backFallback?: Href;
  search: ReactNode;
  searchOpen: boolean;
  onOpenSearch?: () => void;
  canFilter?: boolean;
  activeFilterCount: number;
  onOpenFilters: () => void;
};

export function SessionListHeader({
  title,
  tabHeader,
  headerAction,
  showBackButton = false,
  backFallback,
  search,
  searchOpen,
  onOpenSearch,
  canFilter = true,
  activeFilterCount,
  onOpenFilters,
}: Readonly<SessionListHeaderProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { left, right } = useSafeAreaInsets();
  const sidePadding = useMemo(
    () => ({ paddingLeft: 22 + left, paddingRight: 22 + right }),
    [left, right]
  );
  return (
    <>
      <ScreenHeader
        title={title}
        size="large"
        showBackButton={showBackButton}
        backFallback={backFallback}
        className="px-[22px] pb-0"
        inlineActions={
          <View className="min-w-0 shrink flex-row items-center">
            <View className="min-w-0 shrink">
              <ContextControl />
            </View>
            {headerAction}
          </View>
        }
        allowInlineActionsStacking={false}
      />
      <View style={sidePadding}>
        <View className="min-h-[48px] flex-row items-center justify-between border-b border-border">
          {onOpenSearch ? tabHeader : search}
          <View className="shrink-0 flex-row items-center">
            {onOpenSearch ? (
              <IconButton
                accessibilityLabel={t('agents.search.searchSessions')}
                accessibilityState={{ expanded: searchOpen }}
                testID="agents-open-search"
                onPress={onOpenSearch}
              >
                <Search size={20} color={colors.mutedForeground} />
              </IconButton>
            ) : null}
            {canFilter ? (
              <SessionFilterButton
                activeCount={activeFilterCount}
                testID="agents-open-filters"
                hitSlop={0}
                onPress={onOpenFilters}
              />
            ) : null}
          </View>
        </View>
      </View>
      {onOpenSearch && searchOpen ? search : null}
    </>
  );
}
