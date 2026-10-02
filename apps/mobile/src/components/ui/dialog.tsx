import { Content, Portal, Root } from '@rn-primitives/dialog';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { cn } from '@/lib/utils';

/**
 * The app's dialog surfaces. This file is the only place that imports
 * `@rn-primitives/dialog`; everything else imports from here. See the "Unified
 * Elements" table in `apps/mobile/AGENTS.md`.
 *
 * Both surfaces render inside the app's React tree, so neither can paint above a
 * presented native sheet: use a route with `useFormSheetScreenOptions()`, or the
 * sheet surfaces in `@/components/ui/sheet`, when the dialog must stack over
 * one. A confirm reached from a sheet uses `DestructiveConfirmDialog` directly,
 * which is a native sheet and does stack.
 */

type DialogCardProps = {
  /** Dismiss the card. A backdrop tap and Android Back both route here. */
  onClose: () => void;
  /** Where the card sits in the window. Defaults to the centre. */
  placement?: 'top' | 'centred';
  children: React.ReactNode;
};

/**
 * A form in a card, over a dimmed app. Dismissing is the caller's, and the card
 * hosts arbitrary content: use this for a dialog that is not a confirm — a
 * rename field, a rating form.
 *
 * `@rn-primitives/dialog` owns Android Back, the accessibility escape and the
 * accessibility focus. It does not own the backdrop, so this card draws its own
 * pressable backdrop: a tap outside dismisses, the way the RN `Modal` it
 * replaced did.
 */
export function DialogCard({
  onClose,
  placement = 'centred',
  children,
}: Readonly<DialogCardProps>) {
  return (
    <Root
      open
      onOpenChange={open => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Portal>
        <Content
          accessibilityViewIsModal
          className={cn(
            'absolute inset-0 px-6',
            placement === 'top' ? 'justify-start pt-[25%]' : 'justify-center'
          )}
        >
          <Pressable accessible={false} className="absolute inset-0" onPress={onClose}>
            <View className="absolute inset-0 bg-black opacity-50" />
          </Pressable>
          <View className="gap-4 rounded-xl bg-card p-5">{children}</View>
        </Content>
      </Portal>
    </Root>
  );
}

type ConfirmDialogRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  /** The safe choice's label; defaults to the generic Cancel. */
  cancelLabel?: string;
  /** A third, non-destructive choice rendered between Cancel and the confirm. */
  extraAction?: { label: string; onPress: () => void };
  onConfirm: () => void;
};

/**
 * The confirmation state plus its node. Call `confirm(request)` where the
 * confirmation is triggered and render `{dialog}` in the same tree:
 *
 * ```tsx
 * const { confirm, dialog } = useConfirmDialog();
 * ...
 * <Pressable onPress={() => { confirm({ title, message, confirmLabel, onConfirm }); }} />
 * ...
 * {dialog}
 * ```
 *
 * The node renders nothing while no request is pending. Do not call `confirm`
 * from a tree that unmounts before the user answers — mount the dialog in a
 * tree that outlives the trigger, as `FeedbackPromptProvider` does for the
 * feedback prompt.
 */
export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);

  const confirm = useCallback((next: ConfirmDialogRequest) => {
    setRequest(next);
  }, []);

  const dismiss = useCallback(() => {
    setRequest(null);
  }, []);

  const dialog =
    request === null ? null : (
      <DestructiveConfirmDialog
        title={request.title}
        message={request.message}
        confirmLabel={request.confirmLabel}
        cancelLabel={request.cancelLabel}
        extraAction={request.extraAction}
        onConfirm={() => {
          setRequest(null);
          request.onConfirm();
        }}
        onCancel={dismiss}
      />
    );

  return { confirm, dialog };
}

export type { ConfirmDialogRequest, DialogCardProps };
