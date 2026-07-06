import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { CircleUserRound } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function ProfileAvatarButton() {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        router.navigate('/(app)/profile');
      }}
      accessibilityRole="button"
      accessibilityLabel="Open profile"
      className="h-11 w-11 items-center justify-center rounded-full active:opacity-70"
    >
      <CircleUserRound size={22} color={colors.foreground} />
    </Pressable>
  );
}
