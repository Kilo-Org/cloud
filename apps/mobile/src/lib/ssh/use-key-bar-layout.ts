import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { chainSave } from '@/lib/hooks/save-chain';

import {
  DEFAULT_KEY_BAR_LAYOUT,
  type KeyBarLayout,
  loadKeyBarLayout,
  moveKeyBarKey,
  moveKeyBarKeyTo,
  resetKeyBarLayout,
  saveKeyBarLayout,
  setKeyBarKeyHidden,
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
 * they were made; a write that fails puts the layout back and says why. A read
 * that fails keeps the default layout on screen and reports `error`, which the
 * editor answers with a Retry and the default order.
 */
export function useKeyBarLayout(): KeyBarLayoutState {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<KeyBarLayout>(DEFAULT_KEY_BAR_LAYOUT);
  const [status, setStatus] = useState<KeyBarLayoutStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const layoutRef = useRef(layout);
  const editedRef = useRef(false);
  const loadTokenRef = useRef(0);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    loadTokenRef.current += 1;
    const token = loadTokenRef.current;
    void (async () => {
      try {
        const stored = await loadKeyBarLayout();
        if (loadTokenRef.current !== token || editedRef.current) {
          return;
        }
        layoutRef.current = stored;
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
      const previous = layoutRef.current;
      if (next === previous) {
        return;
      }
      editedRef.current = true;
      layoutRef.current = next;
      setLayout(next);
      setStatus('ready');
      void (async () => {
        try {
          await chainSave(SAVE_KEY, write);
        } catch (error) {
          if (layoutRef.current === next) {
            layoutRef.current = previous;
            setLayout(previous);
          }
          toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'));
        }
      })();
    },
    [t]
  );

  const setHidden = useCallback(
    (id: TerminalKeyId, hidden: boolean) => {
      const next = setKeyBarKeyHidden(layoutRef.current, id, hidden);
      apply(next, () => saveKeyBarLayout(next));
    },
    [apply]
  );

  const move = useCallback(
    (id: TerminalKeyId, offset: -1 | 1) => {
      const next = moveKeyBarKey(layoutRef.current, id, offset);
      apply(next, () => saveKeyBarLayout(next));
    },
    [apply]
  );

  const moveTo = useCallback(
    (from: number, to: number) => {
      const next = moveKeyBarKeyTo(layoutRef.current, from, to);
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
