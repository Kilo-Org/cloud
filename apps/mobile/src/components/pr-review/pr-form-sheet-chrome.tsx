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
  // The reference the caller names in `eyebrow` (owner/repo#number) is what
  // tells two sheets apart, so it rides the shared header's own caption line
  // under the title instead of a composed title the header cannot truncate
  // apart. `close` keeps the one control this sheet has: the X that closes it.
  return (
    <SheetHeader
      title={props.title}
      eyebrow={props.eyebrow}
      variant="close"
      onDone={props.onBack}
      doneLabel={t('common.close')}
      topInset={useFormSheetHeaderTopInset()}
    />
  );
}

/**
 * Trailing ScrollView footer for formSheets: the shared footer bar owns the
 * safe-area band under the CTAs, while the keyboard lift stays with the scroll
 * view (`keyboard="host"`), whose `automaticallyAdjustKeyboardInsets` hosts the
 * footer as trailing content.
 */
export function PrFormSheetFooter(props: { children: ReactNode }) {
  return (
    <ScreenFooter clearance="safe-area" keyboard="host" className="mt-3">
      {props.children}
    </ScreenFooter>
  );
}
