import { useRouter } from 'expo-router';
import { type RefObject, useContext, useEffect, useRef } from 'react';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { NavigationContext } from '@/lib/navigation/navigation-context';
import { useMutedDisabledInk, useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Header Save action shared by Security Agent settings screens: disabled
 * until the screen is dirty and valid, shows a spinner while the save
 * mutation is pending, then pops the screen on success. A refused save is
 * announced by the calling screen's own refusal line (these screens turn the
 * mutation's failure toast off), so this just stays put.
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
  const mutedDisabledInk = useMutedDisabledInk();
  const { t } = useTranslation();
  // A save that settles after this screen is gone must not pop the stack from
  // behind: the discard path of the screen's back guard, or the disabled-config
  // replace, can unmount this instance while its mutation is still in flight.
  // The unmount flag covers the pop and the conditional renders; the focus read
  // covers the route that blurred without unmounting (a screen replaced over
  // this one). Same context object as `useRouteFocused`, read at settle time —
  // the route can blur after the last render and before the promise resolves,
  // so the render-time value is not trustworthy. A caller outside a navigator
  // (and a harness with a partial expo-router mock) has no navigation object:
  // the read is `undefined` and degrades to "current".
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const navigation = useContext(NavigationContext) as { isFocused?: () => boolean } | undefined;
  // One save at a time, claimed synchronously: two presses delivered before the
  // mutation's `pending` prop re-renders would otherwise each start `onSave`.
  // The disabled prop stays the visible state; this is the admission guard.
  const inFlightRef = useRef(false);
  // A settings header holds this one action, and a filled primary is the
  // loudest thing on the screen. It should not outshout the content's own way
  // out (the repository picker's "Manage GitHub App access" is exactly that
  // case) while there is nothing to save, so the fill only appears with a
  // pending change. Before that the action is a quiet text control: still
  // present and still disabled, so its place in the header never moves.
  const actionable = dirty && valid;
  // The spinner has to follow the surface it sits in. While a save is in
  // flight the filled variant is disabled, so the button paints the muted
  // disabled fill and the spinner takes the ink that fill is paired with; the
  // quiet variant keeps the body foreground. A hard-coded primary ink vanished
  // when the draft turned invalid while a save was in flight and the header
  // fell back to the quiet style.
  const spinnerColor = actionable ? mutedDisabledInk : colors.foreground;

  return (
    <Button
      size="sm"
      variant={actionable ? 'default' : 'ghost'}
      disabled={!actionable || pending}
      onPress={() => {
        // Admission before the first await: a second press in the same frame
        // returns before it can start a duplicate write. A save that was
        // refused clears the claim, so the retry path stays open.
        if (inFlightRef.current) {
          return;
        }
        inFlightRef.current = true;
        void (async () => {
          try {
            await onSave();
            // The save has settled, but its screen may not own the route
            // anymore: discard-and-leave through the back guard, or the
            // disabled-config replace, can beat the promise here. Skip both
            // the guard bypass and the pop — a skip flag set without the
            // navigation it was armed for would swallow the next genuine
            // back confirmation on whatever screen is on top now.
            if (mountedRef.current && (navigation?.isFocused?.() ?? true)) {
              skipNextGuardRef.current = true;
              router.back();
            }
          } catch {
            // The screen's refusal line reports the failure; stay on screen.
          } finally {
            inFlightRef.current = false;
          }
        })();
      }}
      // The Button's own base is `shrink-0`, so ScreenHeader's
      // half-row clamp trims the trailing box while this label keeps its
      // width: the catalog "Save changes" is 28 glyphs in French, and at
      // ~214 dp it consumed the row and left the screen title at ~0 width on
      // the narrowest 320 dp viewport. A variable-width header action must
      // bound itself at its source, so this carries the same 140 dp cap as PR
      // review's Submit review (see the trailing-cluster note in
      // screen-header.tsx). 140 dp keeps the button and the 44 dp back control
      // inside the row and leaves the flex-1 title room to draw; the label
      // shrinks and wraps in place instead of clipping.
      className="min-w-0 max-w-[140px] shrink"
    >
      {pending ? <ActivityIndicator size="small" color={spinnerColor} /> : null}
      <Text className="shrink text-center">{t('securityAgent.settingsSave.saveChanges')}</Text>
    </Button>
  );
}
