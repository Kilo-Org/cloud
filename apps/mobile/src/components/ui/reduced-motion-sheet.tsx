import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, type Text as RNText, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { cn } from '@/lib/utils';

// Non-animated action-sheet equivalent for Android Reduce Motion (D6 revised,
// D21). A host mounted once beside `ActionSheetProvider` holds the visible
// model; `showReducedMotionSheet` dispatches through a module-level listener
// (the same imperative pattern the toast library uses). Native `Modal` with
// `animationType="none"` — no animation of any kind.
//
// Accessibility contract (final cumulative r6):
// - The sheet card is `accessibilityViewIsModal`, so the backdrop and the
//   screen behind the Modal are unreachable while the sheet is open — one
//   isolated dialog tree. Screen-reader dismissal is the Cancel item when the
//   caller provides one (the same contract the library sheet exposes).
// - The caller's title, when present, is a named heading (header role) and
//   the deterministic entry-focus target on `onShow`; a sheet without a title
//   lands entry focus on its first action instead.
// - Return focus is OS-managed: every close path unmounts the native Modal,
//   and the OS returns TalkBack/VoiceOver focus to the previously focused
//   element (the invoker), matching native action-sheet dismissal. The host
//   never moves focus on close, so the return is deterministic.

export type ActionSheetSelectCallback = (index?: number) => void | Promise<void>;

export type ActionSheetListItem = {
  readonly label: string;
  readonly index: number;
  readonly destructive: boolean;
  readonly cancel: boolean;
};

/**
 * Non-animated list model for `showReducedMotionSheet`. `onSelect` fires for
 * an item activation with that item's index; `onDismiss` fires for backdrop or
 * hardware-back dismissal with the cancel index (or `undefined` when the sheet
 * has no cancel button), matching the library callback contract every caller
 * already handles.
 */
export type ActionSheetListModel = {
  readonly title?: string;
  readonly message?: string;
  readonly items: readonly ActionSheetListItem[];
  readonly onSelect: (index: number) => void;
  readonly onDismiss: () => void;
};

type Listener = (model: ActionSheetListModel) => void;

let showListener: Listener | null = null;

/** Imperatively present the non-animated option list. */
export function showReducedMotionSheet(model: ActionSheetListModel): void {
  showListener?.(model);
}

export function ReducedMotionSheetHost() {
  const insets = useSafeAreaInsets();
  const [model, setModel] = useState<ActionSheetListModel | null>(null);
  const headingRef = useRef<RNText | null>(null);
  const firstItemRef = useRef<View | null>(null);

  useEffect(() => {
    showListener = setModel;
    return () => {
      showListener = null;
    };
  }, []);

  if (model === null) {
    return null;
  }

  const dismiss = () => {
    setModel(null);
    model.onDismiss();
  };

  const selectItem = (index: number) => {
    setModel(null);
    model.onSelect(index);
  };

  // Deterministic entry focus: the named heading when the caller provided
  // one and it is mounted, otherwise the first action. `onShow` runs after
  // native presentation, so the heading is normally mounted; `moveA11yFocus`
  // no-ops safely when its target is not.
  const focusEntry = () => {
    if (model.title != null && headingRef.current != null) {
      moveA11yFocus(headingRef);
      return;
    }
    moveA11yFocus(firstItemRef);
  };

  return (
    <Modal transparent animationType="none" visible onShow={focusEntry} onRequestClose={dismiss}>
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={dismiss}
          accessibilityLabel="Dismiss actions"
          accessibilityRole="button"
        />
        <View
          accessibilityViewIsModal
          className="rounded-t-2xl border-t border-border bg-card px-4 pt-3"
          // eslint-disable-next-line react-native/no-inline-styles -- dynamic safe-area bottom inset
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          {model.title ? (
            <Text
              ref={headingRef}
              accessibilityRole="header"
              className="pb-1 text-center text-base font-semibold text-foreground"
            >
              {model.title}
            </Text>
          ) : null}
          {model.message ? (
            <Text variant="muted" className="pb-2 text-center">
              {model.message}
            </Text>
          ) : null}
          <ScrollView bounces={false} className="max-h-[60%]">
            {model.items.map((item, index) => (
              <Pressable
                key={item.index}
                ref={index === 0 ? firstItemRef : undefined}
                onPress={() => {
                  selectItem(item.index);
                }}
                accessibilityRole="button"
                className="min-h-12 justify-center active:opacity-70"
              >
                <Text
                  className={cn(
                    'py-2 text-center text-base font-medium',
                    item.destructive && 'text-destructive'
                  )}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
