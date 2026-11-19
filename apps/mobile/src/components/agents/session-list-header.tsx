import { type ReactNode } from 'react';
import { type Href } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { ContextControl } from '@/components/context-control';
import { ScreenHeader } from '@/components/screen-header';
import { IconButton } from '@/components/ui/icon-button';
import { Search } from '@/components/ui/icons';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { cn } from '@/lib/utils';

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
  const sideInsetStyle = useSideInsetStyle();
  return (
    <>
      <ScreenHeader
        title={title}
        size={showBackButton ? 'default' : 'large'}
        showBackButton={showBackButton}
        backFallback={backFallback}
        inlineActions={
          <View className="min-w-0 shrink flex-row items-center">
            {headerAction}
            <View className="min-w-0 shrink">
              <ContextControl />
            </View>
          </View>
        }
        allowInlineActionsStacking={false}
      />
      <View style={sideInsetStyle} className={SCREEN_GUTTER_CLASS}>
        <View
          className={cn(
            ROW_TARGET_CLASS,
            'flex-row items-center justify-between',
            onOpenSearch && 'border-b-[0.5px] border-hair-soft'
          )}
        >
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
