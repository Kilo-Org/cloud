// Shared formSheet chrome for PR review sheets.
//
// react-native-screens formSheet only honors a pinned header when the screen
// content's direct children are [header, scroll view] (see picker-sheet.tsx).
// An extra wrapper, or a third sticky-footer sibling, makes RNS pin the
// ScrollView full-bleed and overpaint the header. Footer CTAs therefore live
// as trailing ScrollView content, not as a sticky sibling. Header must stay
// OUTSIDE the ScrollView so keyboard focus does not scroll the title off-screen.
//
// The header is the shared `SheetHeader`, which decides who clears the status
// bar from the rule in `lib/form-sheet` before its first frame: a sheet that is
// its stack's first screen presents with the surface at the window top and the
// header reserves the inset itself; a sheet pushed over another screen settles
// at the detent cap, an inset lower, so its header reserves nothing.
//
// Keyboard: ScrollView uses automaticallyAdjustKeyboardInsets, so the footer
// leaves the keyboard lift to its host (`keyboard="host"`) instead of applying
// a second lift that would push the CTAs under the keyboard.

import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

import { SheetHeader } from '@/components/sheet-header';
import { ScreenFooter } from '@/components/ui/screen-footer';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';
import { useTranslation } from 'react-i18next';

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

/** The sheet's pinned title row: the shared header, with Close as the way out. */
export function PrFormSheetHeader(props: { title: string; eyebrow?: string; onBack: () => void }) {
  const { t } = useTranslation();
  // `SheetHeader` owns one title line. The reference the caller names in
  // `eyebrow` (owner/repo#number) is what tells two sheets apart, so it rides
  // on that line instead of a second caption the shared header cannot draw.
  const title = props.eyebrow ? `${props.title} · ${props.eyebrow}` : props.title;
  return (
    <SheetHeader
      title={title}
      onDone={props.onBack}
      doneLabel={t('common.close')}
      topInset={useFormSheetHeaderTopInset()}
    />
  );
}

/**
 * Trailing ScrollView footer for formSheets: the shared footer bar, with the
 * bottom band left to the host (the sheet's own inset and the scroll view's
 * content inset), and no keyboard lift of its own.
 */
export function PrFormSheetFooter(props: { children: ReactNode }) {
  return (
    <ScreenFooter clearance="host" keyboard="host" className="mt-3">
      {props.children}
    </ScreenFooter>
  );
}
