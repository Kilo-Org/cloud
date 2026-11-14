import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { chainSave } from '@/lib/hooks/save-chain';

import {
  DEFAULT_KEY_BAR_LAYOUT,
  type KeyBarLayout,
  type KeyBarLayoutSave,
  loadKeyBarLayout,
  moveKeyBarKey,
  moveKeyBarKeyTo,
  resetKeyBarLayout,
  saveKeyBarLayout,
  setKeyBarKeyHidden,
  settleKeyBarLayoutSave,
  startKeyBarLayoutSave,
} from './key-bar';
import { type TerminalKeyId } from './terminal-keys';

const SAVE_KEY = 'ssh-key-bar';

type KeyBarLayoutStatus = 'loading' | 'ready' | 'error';

export type KeyBarLayoutState = Readonly<{
  layout: KeyBarLayout;
  status: KeyBarLayoutStatus;
  setHidden: (id: TerminalKeyId, hidden: boolean) => void;
  move: (id: TerminalKeyId, offset: -1 | 1) => void;
  moveTo: (from: number, to: number) => void;
  restoreDefault: () => void;
  retry: () => void;
}>;

/**
 * The bar's layout for this device.
 *
 * The bar paints the default order until the stored one arrives, so a terminal
 * opened on a locked database still has its keys. Every edit shows at once and
 * is written behind the previous write, so two quick moves land in the order
 * they were made; a write that fails puts the bar back on the last layout the
 * store confirmed and says why. A read that fails keeps the default layout on
 * screen and reports `error`, which the editor answers with a Retry and the
 * default order.
 */
export function useKeyBarLayout(): KeyBarLayoutState {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<KeyBarLayout>(DEFAULT_KEY_BAR_LAYOUT);
  const [status, setStatus] = useState<KeyBarLayoutStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const saveRef = useRef<KeyBarLayoutSave>({
    shown: DEFAULT_KEY_BAR_LAYOUT,
    persisted: DEFAULT_KEY_BAR_LAYOUT,
  });
  const editedRef = useRef(false);
  const loadTokenRef = useRef(0);

  useEffect(() => {
    loadTokenRef.current += 1;
    const token = loadTokenRef.current;
    void (async () => {
      try {
        const stored = await loadKeyBarLayout();
        if (loadTokenRef.current !== token || editedRef.current) {
          return;
        }
        saveRef.current = { shown: stored, persisted: stored };
        setLayout(stored);
        setStatus('ready');
      } catch {
        if (loadTokenRef.current === token) {
          setStatus('error');
        }
      }
    })();
    return () => {
      loadTokenRef.current += 1;
    };
  }, [attempt]);

  const apply = useCallback(
    (next: KeyBarLayout, write: () => Promise<void>) => {
      if (next === saveRef.current.shown) {
        return;
      }
      editedRef.current = true;
      saveRef.current = startKeyBarLayoutSave(saveRef.current, next);
      setLayout(next);
      setStatus('ready');
      void (async () => {
        try {
          await chainSave(SAVE_KEY, write);
          saveRef.current = settleKeyBarLayoutSave(saveRef.current, next, false);
        } catch (error) {
          const settled = settleKeyBarLayoutSave(saveRef.current, next, true);
          saveRef.current = settled;
          if (settled.shown !== next) {
            setLayout(settled.shown);
          }
          toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
        }
      })();
    },
    [t]
  );

  const setHidden = useCallback(
    (id: TerminalKeyId, hidden: boolean) => {
      const next = setKeyBarKeyHidden(saveRef.current.shown, id, hidden);
      apply(next, () => saveKeyBarLayout(next));
    },
    [apply]
  );

  const move = useCallback(
    (id: TerminalKeyId, offset: -1 | 1) => {
      const next = moveKeyBarKey(saveRef.current.shown, id, offset);
      apply(next, () => saveKeyBarLayout(next));
    },
    [apply]
  );

  const moveTo = useCallback(
    (from: number, to: number) => {
      const next = moveKeyBarKeyTo(saveRef.current.shown, from, to);
      apply(next, () => saveKeyBarLayout(next));
    },
    [apply]
  );

  const restoreDefault = useCallback(() => {
    apply(DEFAULT_KEY_BAR_LAYOUT, resetKeyBarLayout);
  }, [apply]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt(current => current + 1);
  }, []);

  return { layout, status, setHidden, move, moveTo, restoreDefault, retry };
}
