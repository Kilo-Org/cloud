import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { OpenPartDetailContext } from './open-part-detail-context';
import { findPartById } from './part-detail-model';
import { PartDetailSheet } from './part-detail-sheet';
import {
  isSheetVisible,
  type PartDetailEvent,
  type PartDetailPhase,
  presentedPartId,
  reducePartDetailPhase,
  settlePresentation,
} from './part-detail-sheet-phase';

const KEYBOARD_DISMISS_FALLBACK_MS = 1000;

type PartDetailSheetHostProps = {
  messages: readonly StoredMessage[];
  children: ReactNode;
};

/** Keep the leaving part until native dismissal completes, then present any queued part. */
export function PartDetailSheetHost({ messages, children }: Readonly<PartDetailSheetHostProps>) {
  const [phase, setPhase] = useState<PartDetailPhase>({ kind: 'closed' });
  const keyboardVisible = useKeyboardState(state => state.isVisible);
  const keyboardVisibleRef = useRef(keyboardVisible);
  keyboardVisibleRef.current = keyboardVisible;

  const dispatch = useCallback((event: PartDetailEvent) => {
    setPhase(current => reducePartDetailPhase(current, event));
  }, []);

  useEffect(() => {
    if (phase.kind !== 'deferred') {
      return undefined;
    }
    if (!keyboardVisible) {
      dispatch({ type: 'keyboard-hidden' });
      return undefined;
    }
    // Interactive hides can miss their completion event; match the discard guard's bound.
    const timeout = setTimeout(() => {
      dispatch({ type: 'keyboard-hidden' });
    }, KEYBOARD_DISMISS_FALLBACK_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [phase.kind, keyboardVisible, dispatch]);

  const partId = presentedPartId(phase);
  const part = partId ? findPartById(messages, partId) : null;

  const open = useCallback(
    (openedPartId: string) => {
      Keyboard.dismiss();
      dispatch({
        type: 'request',
        partId: openedPartId,
        keyboardVisible: keyboardVisibleRef.current,
      });
    },
    [dispatch]
  );

  const close = useCallback(() => {
    dispatch({ type: 'close' });
  }, [dispatch]);

  const handleDismiss = useCallback(() => {
    // Reduced against the queued state, not this render's: the adapter reports the
    // close and the finished dismissal in one pair, so the close may still be a
    // pending update here.
    setPhase(settlePresentation);
  }, []);

  return (
    <>
      <OpenPartDetailContext.Provider value={open}>{children}</OpenPartDetailContext.Provider>
      <PartDetailSheet
        visible={isSheetVisible(phase)}
        part={part}
        onClose={close}
        onDismiss={handleDismiss}
      />
    </>
  );
}
