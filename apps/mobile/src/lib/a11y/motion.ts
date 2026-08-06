import { type ActionSheetOptions, useActionSheet } from '@expo/react-native-action-sheet';
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import {
  type ActionSheetListModel,
  type ActionSheetSelectCallback,
  showReducedMotionSheet,
} from '@/components/ui/reduced-motion-sheet';

// Centralized reduced-motion policy (P3-C-05, D15/D21).
//
// Android action sheets from `@expo/react-native-action-sheet` animate a fixed
// 225/195ms presentation, which is the confirmed violation. iOS delegates to
// the OS (`ActionSheetIOS`), and system Reduce Motion governs the native
// presentation, so iOS keeps the library sheet. The Android immediate
// equivalent is one shared non-animated native `Modal` option list
// (`reduced-motion-sheet.tsx`) driven by the pure mapper below.

/**
 * Pure mapper from the library's action-sheet options to the reduced-motion
 * list model. Destructive and cancel flags come from their indices; the
 * library types `destructiveButtonIndex` as a single index or an array, and
 * both map 1:1. Item order is preserved so the cancel entry stays where each
 * caller put it (last). Arbitrary option counts map 1:1 — `Alert.alert` was
 * rejected because Android caps alerts at three buttons (D6 revised).
 * `onSelect` is the library's selection callback (the same one
 * `showActionSheetWithOptions` receives): it reports the chosen item index,
 * or the cancel index on dismissal.
 */
export function actionSheetToListModel(
  options: ActionSheetOptions,
  onSelect: ActionSheetSelectCallback
): ActionSheetListModel {
  const { cancelButtonIndex, destructiveButtonIndex } = options;
  return {
    title: options.title,
    message: options.message,
    items: options.options.map((label, index) => ({
      label,
      index,
      destructive:
        destructiveButtonIndex != null &&
        (Array.isArray(destructiveButtonIndex)
          ? destructiveButtonIndex.includes(index)
          : destructiveButtonIndex === index),
      cancel: cancelButtonIndex === index,
    })),
    onSelect: index => {
      void onSelect(index);
    },
    onDismiss: () => {
      void onSelect(cancelButtonIndex);
    },
  };
}

export type MotionPolicy = {
  reduceMotion: boolean;
  /** `false` when reduce motion is on, so imperative scrolls go immediate. */
  scrollAnimated: boolean;
};

/** Wrap Reanimated's `useReducedMotion` in the app's motion vocabulary. */
export function useMotionPolicy(): MotionPolicy {
  const reduceMotion = useReducedMotion();
  return {
    reduceMotion,
    scrollAnimated: !reduceMotion,
  };
}

export type ShowActionSheetWithOptions = (
  options: ActionSheetOptions,
  onSelect: ActionSheetSelectCallback
) => void;

/**
 * `useActionSheet()` with the reduced-motion override. iOS and motion-allowed
 * Android delegate to the library sheet unchanged. Android with reduce motion
 * on shows the shared non-animated `Modal` option list instead.
 */
export function useAppActionSheet(): {
  readonly showActionSheetWithOptions: ShowActionSheetWithOptions;
} {
  const { showActionSheetWithOptions } = useActionSheet();
  const { reduceMotion } = useMotionPolicy();

  const show = useCallback<ShowActionSheetWithOptions>(
    (options, onSelect) => {
      if (Platform.OS === 'android' && reduceMotion) {
        showReducedMotionSheet(actionSheetToListModel(options, onSelect));
        return;
      }
      showActionSheetWithOptions(options, onSelect);
    },
    [reduceMotion, showActionSheetWithOptions]
  );

  return { showActionSheetWithOptions: show };
}
