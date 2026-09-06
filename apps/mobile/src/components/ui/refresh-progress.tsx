import { type ScrollViewProps, View } from 'react-native';

import { Loader2 } from '@/components/ui/icons';
import { useProvidedMotionPolicy } from '@/lib/a11y/motion-context';
import { darkColors } from '@/lib/hooks/theme-colors.generated';

type RefreshProgressProps = {
  refreshControl: NonNullable<ScrollViewProps['refreshControl']>;
};

export function RefreshProgress({ refreshControl }: Readonly<RefreshProgressProps>) {
  const reducedMotion = useProvidedMotionPolicy()?.reducedMotion ?? false;
  const { colors, refreshing, tintColor } = refreshControl.props;
  const showStaticProgress = reducedMotion && refreshing;

  return (
    <View
      accessibilityRole={showStaticProgress ? 'progressbar' : undefined}
      className={`${reducedMotion ? 'h-9' : 'h-0'} items-center justify-center`}
      pointerEvents="none"
    >
      {showStaticProgress ? (
        <Loader2 color={tintColor ?? colors?.[0] ?? darkColors.mutedForeground} size={20} />
      ) : null}
    </View>
  );
}
