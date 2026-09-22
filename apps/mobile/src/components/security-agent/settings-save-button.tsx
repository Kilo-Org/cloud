import { useRouter } from 'expo-router';
import { type RefObject } from 'react';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

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
  skipNextGuardRef,
}: Readonly<{
  dirty: boolean;
  valid: boolean;
  pending: boolean;
  onSave: () => Promise<void>;
  // From useSettingsBackGuard — set right before router.back() so the
  // back-navigation this button itself triggers doesn't get intercepted as
  // an unconfirmed exit (see use-settings-back-guard.ts).
  skipNextGuardRef: RefObject<boolean>;
}>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <Button
      size="sm"
      // ScreenHeader's trailing cluster is content-sized and never shrinks
      // (`screen-header.tsx`), so a label whose width grows with the font
      // scale has nothing squeezing it from outside: uncapped, it consumes the
      // row, collapses the `flex-1 min-w-0` title to zero and then paints past
      // the screen edge. Bound it here, exactly as pr-review's Submit review
      // does (140 dp leaves the title ~104 dp on the narrowest 320 dp
      // viewport, and the label wraps in place instead of clipping).
      className="min-w-0 max-w-[140px] shrink px-3"
      disabled={!dirty || !valid || pending}
      onPress={() => {
        void (async () => {
          try {
            await onSave();
            skipNextGuardRef.current = true;
            router.back();
          } catch {
            // Centralized onError already toasted; stay on screen.
          }
        })();
      }}
    >
      {pending ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : null}
      <Text className="shrink text-center">{t('securityAgent.settingsSave.saveChanges')}</Text>
    </Button>
  );
}
