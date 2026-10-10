/* eslint-disable @typescript-eslint/promise-function-async, require-await -- The confirm settles the returned Promise from the dialog's own callback, so the function cannot await anything. */
import { createElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { i18n } from '@/i18n';

export type RemoteSessionExitConfirmation = {
  /**
   * Asks the user to confirm the exit. Resolves `true` on Exit session and
   * `false` on Keep session running or a dismissal.
   */
  confirmExit: () => Promise<boolean>;
  /** The confirm node; render it in the host that owns the exit trigger. */
  exitDialog: ReactNode;
};

/**
 * Remote-session exit confirm. The native `Alert.alert` cannot carry the
 * destructive affordance on Android: its `AlertDialog` paints every button
 * with the theme accent, so `style: 'destructive'` never reaches the screen
 * there. This is the in-app `DestructiveConfirmDialog` on both platforms
 * instead — one implementation, with the destructive red fill and a neutral
 * outline.
 *
 * The hook holds the pending answer in a ref and returns the node the caller
 * mounts; the node is null while the confirm is closed. A host that unmounts
 * with the confirm still open answers "keep running", the same answer a
 * dismissed native alert gave.
 */
export function useRemoteSessionExitConfirmation(): RemoteSessionExitConfirmation {
  const [isOpen, setIsOpen] = useState(false);
  const settleRef = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(
    () => () => {
      settleRef.current?.(false);
      settleRef.current = null;
    },
    []
  );

  const settle = useCallback((confirmed: boolean) => {
    const resolve = settleRef.current;
    settleRef.current = null;
    setIsOpen(false);
    resolve?.(confirmed);
  }, []);

  const confirmExit = useCallback(
    (): Promise<boolean> =>
      new Promise<boolean>(resolve => {
        settleRef.current = resolve;
        setIsOpen(true);
      }),
    []
  );

  return {
    confirmExit,
    exitDialog: isOpen
      ? createElement(DestructiveConfirmDialog, {
          title: i18n.t('agentChat.remoteSession.exitTitle'),
          message: i18n.t('agentChat.remoteSession.exitMessage'),
          confirmLabel: i18n.t('agentChat.remoteSession.exitSession'),
          cancelLabel: i18n.t('agentChat.remoteSession.keepSessionRunning'),
          onConfirm: () => {
            settle(true);
          },
          onCancel: () => {
            settle(false);
          },
        })
      : null,
  };
}
