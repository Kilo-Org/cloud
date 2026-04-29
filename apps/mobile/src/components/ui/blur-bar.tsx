import { BlurView } from 'expo-blur';
import { type ReactNode } from 'react';
import { Platform, useColorScheme, View } from 'react-native';

import { cn } from '@/lib/utils';

type BlurBarProps = {
  children: ReactNode;
  className?: string;
  intensity?: number;
};

/**
 * Translucent bar background. iOS uses `expo-blur`. Android and web
 * fall back to a solid card surface because BlurView performance on
 * low-end Android is unreliable.
 */
export function BlurBar({ children, className, intensity = 40 }: Readonly<BlurBarProps>) {
  const scheme = useColorScheme();
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={intensity}
        tint={scheme === 'dark' ? 'dark' : 'light'}
        className={cn('border-t-[0.5px] border-border', className)}
      >
        {children}
      </BlurView>
    );
  }
  return (
    <View className={cn('bg-background border-t-[0.5px] border-border', className)}>
      {children}
    </View>
  );
}
