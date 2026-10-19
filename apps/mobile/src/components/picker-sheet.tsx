import { Info } from '@/components/ui/icons';
import { useRouter } from 'expo-router';
import { type ReactNode, useContext, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { NavigationContext } from '@/lib/navigation/navigation-context';
import { SheetHeader } from '@/components/sheet-header';

export function PickerSheet({
  title,
  onDone,
  onCancel,
  doneLabel,
  cancelLabel,
  children,
  headerContent,
  expired = false,
  scrollable = true,
  disabled = false,
  onHardwareBack,
}: {
  title: string;
  onDone: () => void;
  onCancel?: () => void;
  doneLabel?: string;
  /** Overrides the leading control's text and accessibility label (nested Back). */
  cancelLabel?: string;
  children?: ReactNode;
  headerContent?: ReactNode;
  /** Set when the caller's data source (picker bridge) is gone — renders the standard "Options expired" empty state instead of children. */
  expired?: boolean;
  /**
   * Set to false when children manage their own scrolling (e.g. a FlatList
   * with search-as-you-type rows) — the shell then just renders them below
   * the header instead of nesting them in a ScrollView.
   */
  scrollable?: boolean;
  /** Disables the header Done/Cancel controls while the caller applies a choice. */
  disabled?: boolean;
  /**
   * Hardware Back override (Android; RN ships BackHandler as a no-op on iOS).
   * Return `true` after consuming a step (e.g. popping a drill frame) to keep
   * the sheet open; return `false` to let the shell dismiss. When absent, Back
   * dismisses the route with `router.back()` — never `onDone`, which several
   * sheets use to commit a choice (save, apply, reload). Arming this listener
   * keeps Back during the sheet's opening transition on the same JS-driven
   * dismiss path as the header controls instead of racing the native
   * BottomSheetBehavior dismissal.
   */
  onHardwareBack?: () => boolean;
}) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  // Focus comes from the navigation context rather than `useNavigation()`:
  // surfaces rendered outside a navigator (an excluded feature's chat sheet)
  // and harnesses with a partial expo-router mock then mount unchanged —
  // `useContext` returns undefined instead of throwing, and the listener
  // degrades to nothing. The context value is structurally partial here: the
  // excluded-feature sheet renders without a navigator above it.
  const navigation = useContext(
    NavigationContext as React.Context<{ isFocused: () => boolean } | undefined>
  );
  const router = useRouter();

  // Latest-callback refs: the listener is armed once per mount and must run
  // the CURRENT render's callback (a stale closure would re-read the first
  // render's drill stack).
  const onHardwareBackRef = useRef(onHardwareBack);
  onHardwareBackRef.current = onHardwareBack;

  useEffect(() => {
    // RN's BackHandler is a real emitter on Android and a no-op module on iOS.
    // A partial react-native mock may omit the export entirely, and vitest's
    // module mock throws on the property ACCESS itself — so read it inside a
    // guard that degrades to "no listener" instead of failing the mount.
    const readBackHandler = (): typeof BackHandler | undefined => {
      try {
        return BackHandler;
      } catch {
        return undefined;
      }
    };
    const backHandler = readBackHandler();
    const navigationValue = navigation;
    const focus = navigationValue?.isFocused;
    if (!backHandler?.addEventListener || !focus) {
      return undefined;
    }
    const subscription = backHandler.addEventListener('hardwareBackPress', () => {
      // A sheet whose route lost focus (another screen pushed above it, or the
      // native dismissal already popped it) must not pop the stack again: the
      // focus-aware guard collapses the double-dismissal race (native hide →
      // JS pop, user Back → JS pop) into one pop.
      if (!focus()) {
        return false;
      }
      if (onHardwareBackRef.current?.()) {
        // The sheet handled Back internally (e.g. drilled one level up): it
        // stays open.
        return true;
      }
      router.back();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [navigation, router]);

  const body = expired ? (
    <EmptyState
      icon={Info}
      title={t('picker.optionsExpired')}
      description={t('picker.optionsExpiredDescription')}
    />
  ) : (
    children
  );

  // No wrapping View: react-native-screens sizes a formSheet's scroll view
  // natively and only honors a header when [header, scroll view] are the
  // screen content's direct children. An extra wrapper makes it fall back to
  // pinning the scroll view to the full sheet, painting it over the header.
  return (
    <>
      <View collapsable={false}>
        <SheetHeader
          title={title}
          onDone={onDone}
          onCancel={onCancel}
          doneLabel={doneLabel}
          cancelLabel={cancelLabel}
          disabled={disabled}
          topInset="bottom-form-sheet"
        />
        {headerContent}
      </View>
      {scrollable && !expired ? (
        // keyboardShouldPersistTaps keeps a first tap on a row working while
        // a picker's search field holds the keyboard open.
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: bottom + 16 }}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </>
  );
}
