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

/**
 * Paint order of the surfaces that dismiss on Escape or an outside click,
 * mirroring their z-index: an inline card (`z-[25]`) covers a popover
 * (`z-20`), a full-surface dialog or the history overlay (`z-30`) covers
 * both, and a popover rendered inside a dialog paints on top of that dialog.
 */
export const dismissLayer = {
  card: 25,
  dialog: 30,
  popover: 20,
  popoverInDialog: 40,
} as const;

type DismissLayerRank = (typeof dismissLayer)[keyof typeof dismissLayer];

interface DismissLayer {
  readonly dismissOnEscape?: () => void;
  readonly dismissOnPointerDown?: (event: PointerEvent) => void;
  readonly rank: DismissLayerRank;
}

/*
 * A surface joins the stack when it becomes dismissible and leaves when it
 * stops. Only the surface that paints highest handles a gesture, so a dialog
 * covering a card takes the Escape that closes the dialog instead of both,
 * even when the card became dismissible after the dialog opened; equal ranks
 * fall back to the most recently opened surface.
 */
const dismissLayers: DismissLayer[] = [];
let isListening = false;

const findTopLayer = (matches: (layer: DismissLayer) => boolean): DismissLayer | undefined => {
  let top: DismissLayer | undefined = undefined;

  for (const layer of dismissLayers) {
    if (matches(layer) && (top === undefined || layer.rank >= top.rank)) {
      top = layer;
    }
  }

  return top;
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return;
  }

  const layer = findTopLayer(candidate => candidate.dismissOnEscape !== undefined);
  if (layer?.dismissOnEscape === undefined) {
    return;
  }

  event.preventDefault();
  layer.dismissOnEscape();
};

const handlePointerDown = (event: PointerEvent): void => {
  findTopLayer(candidate => candidate.dismissOnPointerDown !== undefined)?.dismissOnPointerDown?.(
    event
  );
};

const pushLayer = (layer: DismissLayer): void => {
  dismissLayers.push(layer);

  if (!isListening) {
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown, true);
    isListening = true;
  }
};

const removeLayer = (layer: DismissLayer): void => {
  const index = dismissLayers.lastIndexOf(layer);
  if (index !== -1) {
    dismissLayers.splice(index, 1);
  }

  if (dismissLayers.length === 0 && isListening) {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('pointerdown', handlePointerDown, true);
    isListening = false;
  }
};

export const useEscapeKey = (
  enabled: boolean,
  onEscape: () => void,
  rank: DismissLayerRank
): void => {
  const onEscapeRef = useLatestRef(onEscape);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const layer: DismissLayer = {
      dismissOnEscape: () => {
        onEscapeRef.current();
      },
      rank,
    };
    pushLayer(layer);

    return () => {
      removeLayer(layer);
    };
  }, [enabled, onEscapeRef, rank]);
};

export const useDismissOnOutsideClick = ({
  enabled,
  onDismiss,
  rank,
  targetRef,
}: {
  enabled: boolean;
  onDismiss: () => void;
  rank: DismissLayerRank;
  targetRef: RefObject<HTMLElement | null>;
}): void => {
  const onDismissRef = useLatestRef(onDismiss);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const layer: DismissLayer = {
      dismissOnPointerDown: (event: PointerEvent) => {
        const target = targetRef.current;
        if (target === null) {
          return;
        }

        if (event.target instanceof Node && target.contains(event.target)) {
          return;
        }

        onDismissRef.current();
      },
      rank,
    };
    pushLayer(layer);

    return () => {
      removeLayer(layer);
    };
  }, [enabled, onDismissRef, rank, targetRef]);
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

    const handleTab = (event: KeyboardEvent): void => {
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

    document.addEventListener('keydown', handleTab);

    const layer: DismissLayer = {
      dismissOnEscape: () => {
        onCloseRef.current();
      },
      rank: dismissLayer.dialog,
    };
    pushLayer(layer);

    return () => {
      document.removeEventListener('keydown', handleTab);
      removeLayer(layer);

      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open, onCloseRef]);

  return dialogRef;
};
