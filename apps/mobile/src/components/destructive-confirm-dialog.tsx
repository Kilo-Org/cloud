import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { isDestructiveTouchPending, useDestructiveHold } from '@/lib/sheet-touch-guard';

export type DestructiveConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  /** The safe choice's label; defaults to the generic Cancel. */
  cancelLabel?: string;
  /**
   * A third, non-destructive choice rendered between Cancel and the confirm —
   * for a confirmation that offers a way out other than "do it" or "don't",
   * such as discarding unsaved changes also offering Save. Pressing it leaves
   * the confirmation the way the other two choices do: the sheet dismisses and
   * `onPress` runs once the dismissal finished.
   */
  extraAction?: { label: string; onPress: () => void };
  /**
   * Asks the dialog to dismiss itself with the safe choice, once, while the
   * caller keeps rendering it: the caller's request lost its answer (an agent's
   * interrupted call) and must go out the way a Cancel goes out. A choice the
   * person already made wins — a pending action or a dismissal in flight is
   * never overridden — and the sheet reports the finished dismissal through
   * `onDismiss` as usual.
   */
  dismissRequested?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * In-app confirmation for a destructive action, rendered with the destructive
 * (red) button variant.
 *
 * The native `Alert.alert` cannot carry the affordance on Android: its
 * `AlertDialog` paints every button with the theme accent, so
 * `style: 'destructive'` never reaches the screen there. This surface renders
 * the confirm in-app on both platforms instead — one implementation, so the
 * destructive red fill and the neutral outline read the same everywhere.
 *
 * It is a native sheet, not an in-tree dialog: a confirm is reached from inside
 * `formSheet` routes and from content already presented in
 * `SessionPageSheet`, where a `@rn-primitives/portal` dialog would render
 * behind the sheet. The sheet sizes to the card and carries no drag indicator,
 * so the stacked buttons are the choices. Both native sheets already keep their
 * content above the home indicator and the navigation bar, so the card adds no
 * bottom inset of its own.
 *
 * Keep the request mounted until native dismissal finishes. The action runs
 * afterward, so deleting its owner cannot empty the sheet during dismissal.
 *
 * All three choices leave that way, the extra one included. It is a
 * save-and-stay rather than a decision about the removal, so the sheet must go
 * either way: the reader lands on the screen the save was about and reads the
 * outcome there — a refusal is reported by that screen's own line, never by a
 * sheet held over it, and a sheet that stayed would also let a second press
 * queue another save behind the first.
 */
export function DestructiveConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  extraAction,
  dismissRequested = false,
  onConfirm,
  onCancel,
}: Readonly<DestructiveConfirmDialogProps>) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(true);
  const pendingAction = useRef<(() => void) | null>(null);
  // The one-shot edge reads the latest handler without re-arming on the
  // handler identity: the host re-renders the dialog with new handler
  // closures while its flag stays true, and only the flag's edge starts a
  // dismissal.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useDestructiveHold();

  const dismiss = useCallback((action: () => void) => {
    if (pendingAction.current !== null) {
      return;
    }
    pendingAction.current = action;
    setVisible(false);
  }, []);

  useEffect(() => {
    if (dismissRequested) {
      dismiss(onCancelRef.current);
    }
  }, [dismissRequested, dismiss]);

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        dismiss(onCancel);
      }}
      onDismiss={() => {
        const action = pendingAction.current ?? onCancel;
        pendingAction.current = null;
        action();
      }}
      showHandle={false}
    >
      <SheetHeader
        title={title}
        variant="close"
        // The sheet floats above its content, never at the window top, so the
        // header reserves no status-bar clearance.
        topInset="never"
        // The card draws no handle and no page chrome above the header, so the
        // header's own padding is the whole band over the title: it takes the
        // body's inset instead of the default `pt-4`, which left the title with
        // twice the space over it that its divider leaves under it.
        padTopToBody
        onDone={() => {
          dismiss(onCancel);
        }}
      />
      <View className={SCREEN_BODY_CLASS}>
        <Text variant="muted">{message}</Text>
        <View className="gap-2">
          <Button
            variant="destructive"
            className="w-full"
            // The destructive choice declines presses for longer than the gate
            // does: while its sheet is still moving, a press aimed at Cancel can
            // land here, and a sign-out from that press is worse than one more
            // press on the control the reader meant. The safe choices below never
            // wait, and the paint never changes — the control looks the same
            // whether or not it is admitting presses. See
            // `@/lib/sheet-touch-guard`.
            onPress={() => {
              if (isDestructiveTouchPending()) {
                return;
              }
              dismiss(onConfirm);
            }}
          >
            <Text>{confirmLabel}</Text>
          </Button>
          {extraAction ? (
            <Button
              variant="secondary"
              className="w-full"
              onPress={() => {
                dismiss(extraAction.onPress);
              }}
            >
              <Text>{extraAction.label}</Text>
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="w-full"
            onPress={() => {
              dismiss(onCancel);
            }}
          >
            <Text>{cancelLabel ?? t('common.cancel')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
