import {
  Action,
  Cancel,
  Content,
  Description,
  Overlay,
  Portal,
  Root,
  Title,
} from '@rn-primitives/alert-dialog';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { DestructiveConfirmDialog } from '@/components/destructive-confirm-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * The app's confirmation dialog. This file is the only place that imports
 * `@rn-primitives/alert-dialog`; everything else imports from here. See the
 * "Unified Elements" table in `apps/mobile/AGENTS.md`.
 *
 * Use this for a confirmation that needs the destructive (red) affordance. A
 * non-destructive system confirm stays `Alert.alert`, because the native alert
 * is the cheapest correct dialog for a plain "are you ok with this".
 */

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel: string;
  /** The safe choice's label; defaults to the generic Cancel. */
  cancelLabel?: string;
  /**
   * A third, non-destructive choice rendered between Cancel and the confirm —
   * for a confirmation that offers a way out other than "do it" or "don't",
   * such as discarding unsaved changes also offering Save.
   */
  extraAction?: ConfirmDialogExtraAction;
  /** Confirm and fire the request, then close. */
  onConfirm: () => void;
};

type ConfirmDialogExtraAction = {
  label: string;
  onPress: () => void;
};

/**
 * Screen-level confirmation dialog, rendered through `@rn-primitives/portal`.
 * It dims the whole app and follows the theme.
 *
 * It renders inside the app's React view tree, so it can never paint above a
 * presented native sheet or a full-screen `Modal` — the caller sees nothing.
 * That is why `useConfirmDialog` renders this surface only when a request asks
 * for `presentation: 'screen'`, and otherwise uses the RN `Modal` confirm.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  cancelLabel,
  extraAction,
  onConfirm,
}: Readonly<ConfirmDialogProps>) {
  const { t } = useTranslation();

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Portal>
        <Overlay className="absolute inset-0 bg-black/50" />
        <Content className="absolute inset-0 items-center justify-center px-6">
          <View
            accessibilityViewIsModal
            className="w-full gap-4 rounded-xl border border-border bg-card p-5"
          >
            <Title className="text-base font-semibold text-foreground">{title}</Title>
            <Description className="text-sm text-muted-foreground">{message}</Description>
            <View className="flex-row justify-end gap-3">
              <Cancel asChild>
                <Button variant="outline">
                  <Text>{cancelLabel ?? t('common.cancel')}</Text>
                </Button>
              </Cancel>
              {extraAction ? (
                <Pressable
                  onPress={() => {
                    extraAction.onPress();
                  }}
                  accessibilityRole="button"
                  className="shrink-0 flex-row items-center justify-center rounded-md active:opacity-70"
                >
                  <Text className="text-sm font-semibold text-foreground">{extraAction.label}</Text>
                </Pressable>
              ) : null}
              <Action asChild onPress={onConfirm}>
                <Button variant="destructive">
                  <Text>{confirmLabel}</Text>
                </Button>
              </Action>
            </View>
          </View>
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
  extraAction?: ConfirmDialogExtraAction;
  /**
   * `'sheet'` (the default) renders the RN `Modal` confirm, which is visible
   * above a native sheet, a full-screen `Modal` and a portal overlay alike.
   *
   * Pass `'screen'` only when the code path is provably a screen that nothing
   * can be presented over — a tab, or a plain stack screen with no sheet on its
   * route. The portal dialog then dims the whole app. It renders inside the
   * app's React tree, so on any other path it would be invisible behind the
   * presented surface.
   */
  presentation?: 'screen' | 'sheet';
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

  let dialog = null;
  if (request !== null) {
    dialog =
      request.presentation === 'screen' ? (
        <ConfirmDialog
          open
          onOpenChange={open => {
            if (!open) {
              dismiss();
            }
          }}
          title={request.title}
          message={request.message}
          confirmLabel={request.confirmLabel}
          cancelLabel={request.cancelLabel}
          extraAction={request.extraAction}
          onConfirm={() => {
            request.onConfirm();
          }}
        />
      ) : (
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
  }

  return { confirm, dialog };
}

export type { ConfirmDialogProps, ConfirmDialogRequest };
