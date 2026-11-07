import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { OpenPartDetailContext } from './open-part-detail-context';
import { findPartById } from './part-detail-model';
import { PartDetailSheet } from './part-detail-sheet';

const KEYBOARD_DISMISS_FALLBACK_MS = 1000;

type PartDetailSheetHostProps = {
  messages: readonly StoredMessage[];
  children: ReactNode;
};

/** Keep the leaving part until native dismissal completes, then present any queued part. */
export function PartDetailSheetHost({ messages, children }: Readonly<PartDetailSheetHostProps>) {
  const [presentedPartId, setPresentedPartId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [pendingPartId, setPendingPartId] = useState<string | null>(null);
  const keyboardVisible = useKeyboardState(state => state.isVisible);
  const dismissing = presentedPartId !== null && !visible;
  const dismissingRef = useRef(dismissing);
  dismissingRef.current = dismissing;
  const keyboardVisibleRef = useRef(keyboardVisible);
  keyboardVisibleRef.current = keyboardVisible;

  if (pendingPartId !== null && !keyboardVisible && !dismissing) {
    setPendingPartId(null);
    setPresentedPartId(pendingPartId);
    setVisible(true);
  }

  useEffect(() => {
    if (pendingPartId === null || !keyboardVisible || dismissing) {
      return undefined;
    }
    // Interactive hides can miss their completion event; match the discard guard's bound.
    const timeout = setTimeout(() => {
      setPendingPartId(null);
      setPresentedPartId(pendingPartId);
      setVisible(true);
    }, KEYBOARD_DISMISS_FALLBACK_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [pendingPartId, keyboardVisible, dismissing]);

  const part = presentedPartId ? findPartById(messages, presentedPartId) : null;

  const open = useCallback((partId: string) => {
    Keyboard.dismiss();
    if (keyboardVisibleRef.current || dismissingRef.current) {
      setPendingPartId(partId);
      return;
    }
    setPendingPartId(null);
    setPresentedPartId(partId);
    setVisible(true);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setPresentedPartId(null);
  }, []);

  return (
    <>
      <OpenPartDetailContext.Provider value={open}>{children}</OpenPartDetailContext.Provider>
      <PartDetailSheet visible={visible} part={part} onClose={close} onDismiss={handleDismiss} />
    </>
  );
}
