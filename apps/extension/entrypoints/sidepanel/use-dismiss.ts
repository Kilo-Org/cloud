import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const listFocusableElements = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
];

const useLatestRef = <TValue>(value: TValue): RefObject<TValue> => {
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return valueRef;
};

/*
 * A control that already handled Escape has called `preventDefault`, and the
 * surface behind it must not dismiss as well. A native `<select>` needs no
 * guard of its own: the browser keeps keys for an open popup, so a focused
 * select still lets Escape reach the dialog.
 */
export const useEscapeKey = (enabled: boolean, onEscape: () => void): void => {
  const onEscapeRef = useLatestRef(onEscape);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      onEscapeRef.current();
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, onEscapeRef]);
};

export const useDismissOnOutsideClick = ({
  enabled,
  onDismiss,
  targetRef,
}: {
  enabled: boolean;
  onDismiss: () => void;
  targetRef: RefObject<HTMLElement | null>;
}): void => {
  const onDismissRef = useLatestRef(onDismiss);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = targetRef.current;
      if (target === null) {
        return;
      }

      if (event.target instanceof Node && target.contains(event.target)) {
        return;
      }

      onDismissRef.current();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [enabled, onDismissRef, targetRef]);
};

/**
 * Modal dialog behavior for a full-surface panel: focus moves into the dialog
 * when it opens, Tab and Shift+Tab cycle inside it, Escape closes it, and focus
 * returns to the element that opened it.
 */
export const useModalDialog = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): RefObject<HTMLDivElement | null> => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useLatestRef(onClose);

  useEffect(() => {
    if (!open) {
      return;
    }

    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!dialog.contains(document.activeElement)) {
      const [firstFocusable] = listFocusableElements(dialog);
      (firstFocusable ?? dialog).focus();
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!event.defaultPrevented) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = listFocusableElements(dialog);
      const [first] = focusable;
      const last = focusable.at(-1);

      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }

        return;
      }

      if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);

      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open, onCloseRef]);

  return dialogRef;
};
