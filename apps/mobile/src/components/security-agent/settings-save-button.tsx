import { useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Header Save action shared by Security Agent settings screens: disabled
 * until the screen is dirty and valid, shows a spinner while the save
 * mutation is pending, then pops the screen on success. Errors are already
 * toasted by the mutation's centralized onError, so this just stays put.
 *
 * Callers still decide whether to render it at all — pass `undefined` for
 * `headerRight` when `!canManage`, same as before this was extracted.
 */
export function SettingsSaveButton({
  dirty,
  valid,
  pending,
  onSave,
}: Readonly<{
  dirty: boolean;
  valid: boolean;
  pending: boolean;
  onSave: () => Promise<void>;
}>) {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <Button
      size="sm"
      disabled={!dirty || !valid || pending}
      onPress={() => {
        void (async () => {
          try {
            await onSave();
            router.back();
          } catch {
            // Centralized onError already toasted; stay on screen.
          }
        })();
      }}
    >
      {pending ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : null}
      <Text>Save changes</Text>
    </Button>
  );
}
