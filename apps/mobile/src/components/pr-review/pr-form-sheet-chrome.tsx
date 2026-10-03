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
// pattern). Scope the header's native safe area to its own view. Direct entry
// can render the route full-screen, while a presented sheet already clears the
// status bar. Keep `pt-5` for the grabber without adding the app inset twice.
//
// Keyboard: ScrollView uses automaticallyAdjustKeyboardInsets. Footers must
// NOT re-apply the full keyboard height: an extra lift beside the native one
// double-counts and pushes CTAs under the keyboard until the user scrolls. Body
// fields cap their height while the keyboard is open so the trailing footer
// still fits in the inset viewport at scroll offset 0.

import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';

const HEADER_SAFE_AREA_STYLE = { flex: 0 };
const HEADER_SAFE_AREA_EDGES = ['top'] as const;

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
  return (
    <SafeAreaProvider collapsable={false} style={HEADER_SAFE_AREA_STYLE}>
      <SafeAreaView edges={HEADER_SAFE_AREA_EDGES}>
        <View collapsable={false} className="border-b border-border bg-background">
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
      </SafeAreaView>
    </SafeAreaProvider>
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
