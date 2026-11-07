import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { OpenPartDetailContext } from './open-part-detail-context';
import { findPartById } from './part-detail-model';
import { PartDetailSheet } from './part-detail-sheet';

type PartDetailSheetHostProps = {
  messages: readonly StoredMessage[];
  children: ReactNode;
};

/**
 * Per-transcript-surface host: provides the context opener to the rows it
 * wraps and mounts the detail sheet. The presented part id survives
 * `visible -> false` and re-resolves from the live `messages` prop on every
 * render, so the sheet keeps its title and body through the native dismiss
 * animation and tracks the part as it streams; only the native `onDismiss`
 * report clears it. Opening while the keyboard is up dismisses the keyboard
 * first and presents once the provider reports it hidden, the same handoff
 * as `useNewSessionDiscardGuard`, and nothing restores the composer's focus
 * afterwards. The fragment never wraps children in a layout view — the
 * FlashList needs flex-1 passthrough.
 */
export function PartDetailSheetHost({ messages, children }: Readonly<PartDetailSheetHostProps>) {
  const [presentedPartId, setPresentedPartId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [pendingPartId, setPendingPartId] = useState<string | null>(null);
  const keyboardVisible = useKeyboardState(state => state.isVisible);
  const keyboardVisibleRef = useRef(keyboardVisible);
  keyboardVisibleRef.current = keyboardVisible;

  if (pendingPartId !== null && !keyboardVisible) {
    setPendingPartId(null);
    setPresentedPartId(pendingPartId);
    setVisible(true);
  }

  const part = presentedPartId ? findPartById(messages, presentedPartId) : null;

  const open = useCallback((partId: string) => {
    if (keyboardVisibleRef.current) {
      Keyboard.dismiss();
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
