import { type ReactNode } from 'react';
import { View } from 'react-native';

import { type LucideIcon } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Shared hero for a tour step: a brand-tinted icon tile above the step's
 * supporting copy. The tile uses the app's secondary surface with the
 * primary (brand) hue on the icon, so the three tour steps read as one
 * finished surface instead of three unrelated layouts.
 */
export function TourStepHero({
  icon: Icon,
  children,
}: Readonly<{ icon: LucideIcon; children: ReactNode }>) {
  const colors = useThemeColors();

  return (
    <View className="items-center gap-4 pt-2">
      <View className="h-16 w-16 items-center justify-center rounded-2xl border border-border bg-secondary">
        <Icon size={28} color={colors.primary} strokeWidth={1.75} />
      </View>
      {children}
    </View>
  );
}
