// Shared formSheet chrome for PR review sheets.
//
// react-native-screens formSheet only honors a pinned header when the screen
// content's direct children are [header, scroll view] (see picker-sheet.tsx).
// An extra wrapper, or a third sticky-footer sibling, makes RNS pin the
// ScrollView full-bleed and overpaint the header. Footer CTAs therefore live
// as trailing ScrollView content, not as a sticky sibling. Header must stay
// OUTSIDE the ScrollView so keyboard focus does not scroll the title off-screen.
//
// collapsable={false}: keep a stable native subview at index 0 (SheetHeader
// pattern). Who clears the status bar depends on how the route was presented,
// and the header decides it before its first frame: a sheet that is its stack's
// first screen presents with the surface at the window top, so the header
// reserves the inset itself; a sheet pushed over another screen settles at the
// detent cap, an inset lower, so its header reserves nothing. Both come from the
// shared rule in `lib/form-sheet`, never from a measured safe-area frame — a
// nested provider reported 0 on the first frame and the inset once it settled,
// which moved the whole header by the status-bar height after it landed. Keep
// `pt-5` for the grabber space on top of the clearance.
//
// Keyboard: ScrollView uses automaticallyAdjustKeyboardInsets. Footers must
// NOT re-apply the full keyboard height: an extra lift beside the native one
// double-counts and pushes CTAs under the keyboard until the user scrolls. Body
// fields cap their height while the keyboard is open so the trailing footer
// still fits in the inset viewport at scroll offset 0.

import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { useSheetHeaderTopClearance } from '@/lib/form-sheet';
import { useRouteIsStackRoot } from '@/lib/navigation/route-focus';

export function useFormSheetKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => {
      setVisible(true);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}

export function PrFormSheetHeader(props: { title: string; eyebrow: string; onBack: () => void }) {
  const isStackRoot = useRouteIsStackRoot();
  const topClearance = useSheetHeaderTopClearance(
    isStackRoot ? 'android-window-top' : 'bottom-form-sheet'
  );
  return (
    <View
      collapsable={false}
      className="border-b border-border bg-background"
      style={topClearance > 0 ? { paddingTop: topClearance } : undefined}
    >
      {/* Left-aligned heading on the back row: `centerTitle` would split the
          header into a centered title row and a second row holding a lone
          dismiss chevron, which read as a stray control under the title. */}
      <ScreenHeader
        title={props.title}
        eyebrow={props.eyebrow}
        onBack={props.onBack}
        backIcon="close"
        showBackButton
        safeAreaTop={false}
        className="pt-5"
      />
    </View>
  );
}

/**
 * Trailing ScrollView footer for formSheets. No keyboard-height padding —
 * parent ScrollView automaticallyAdjustKeyboardInsets owns that. On Android
 * the footer sits on the bottom edge, so it adds the system bottom inset.
 * The px-6 gutter is widened by the side insets so the footer CTAs clear the
 * landscape safe area when the sheet runs edge-to-edge (portrait insets are
 * zero, so the gutter stays 24).
 */
export function PrFormSheetFooter(props: { children: ReactNode }) {
  const { bottom, left, right } = useSafeAreaInsets();
  const paddingBottom = Platform.OS === 'android' ? 16 + bottom : 16;
  const paddingLeft = 24 + left;
  const paddingRight = 24 + right;
  return (
    <View
      className="mt-0.5 border-t-[0.5px] border-hair-soft bg-background pt-3"
      style={{ paddingBottom, paddingLeft, paddingRight }}
    >
      {props.children}
    </View>
  );
}
