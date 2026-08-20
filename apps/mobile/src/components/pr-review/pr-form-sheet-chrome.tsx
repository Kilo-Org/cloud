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
// pattern). No `modal` top inset: the formSheet grabber already clears the
// top edge; the modal 32pt pad left a transparent band content showed through
// (that band + parent PR "Go back" is the stray ‹ root cause).
//
// Keyboard: ScrollView uses automaticallyAdjustKeyboardInsets. Footers must
// NOT re-apply the full keyboard height (AppAwareKeyboardPaddingView double-
// counted and pushed CTAs under the keyboard until the user scrolled). Body
// fields cap their height while the keyboard is open so the trailing footer
// still fits in the inset viewport at scroll offset 0.

import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { cn } from '@/lib/utils';

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
    <View collapsable={false} className="border-b border-border bg-background">
      <ScreenHeader
        title={props.title}
        eyebrow={props.eyebrow}
        onBack={props.onBack}
        backIcon="close"
        className="pt-3"
      />
    </View>
  );
}

/**
 * Trailing ScrollView footer for formSheets. No keyboard-height padding —
 * parent ScrollView automaticallyAdjustKeyboardInsets owns that.
 */
export function PrFormSheetFooter(props: { children: ReactNode; className?: string }) {
  return (
    <View
      className={cn(
        'mt-0.5 border-t-[0.5px] border-hair-soft bg-background px-6 pb-4 pt-3',
        props.className
      )}
    >
      {props.children}
    </View>
  );
}
