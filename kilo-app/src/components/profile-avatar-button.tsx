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
        router.push('/(app)/profile');
      }}
      accessibilityRole="button"
      accessibilityLabel="Open profile"
    >
      <CircleUserRound size={22} color={colors.foreground} />
    </Pressable>
  );
}
