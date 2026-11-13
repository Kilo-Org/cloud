import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView } from 'react-native';

import { ChevronRight } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type Breadcrumb } from '@/lib/ssh/files/paths';
import { cn } from '@/lib/utils';

type BreadcrumbBarProps = Readonly<{
  trail: readonly Breadcrumb[];
  onOpen: (path: string) => void;
}>;

/**
 * The path above the list, one pressable segment per directory. It scrolls
 * horizontally and keeps its end — the current directory — in view.
 */
export function BreadcrumbBar({ trail, onOpen }: BreadcrumbBarProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const scroller = useRef<ScrollView>(null);

  useEffect(() => {
    scroller.current?.scrollToEnd({ animated: false });
  }, [trail]);

  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="items-center gap-0.5 px-4 py-2"
      accessibilityRole="none"
    >
      {trail.map((crumb, index) => {
        const current = index === trail.length - 1;
        return (
          <Pressable
            key={crumb.path}
            accessibilityRole="button"
            accessibilityLabel={
              current ? t('ssh.files.currentFolder', { name: crumb.label }) : crumb.label
            }
            disabled={current}
            hitSlop={6}
            className={cn(
              'max-w-[180px] flex-row items-center gap-0.5 rounded-md px-1.5 py-1',
              current ? undefined : 'active:bg-secondary'
            )}
            onPress={() => {
              onOpen(crumb.path);
            }}
          >
            <Text
              className={cn(
                'text-sm',
                current ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'
              )}
              numberOfLines={1}
            >
              {crumb.label}
            </Text>
            {current ? null : <ChevronRight size={14} color={colors.mutedForeground} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
