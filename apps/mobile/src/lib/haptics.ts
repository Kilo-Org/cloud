import * as Haptics from 'expo-haptics';

/**
 * Haptic feedback is decoration: a device without a haptic engine, or a native
 * call that fails, must neither skip the action the tap asked for nor leave a
 * rejected promise behind. Every call below therefore reports nothing and
 * returns a settled promise.
 */
async function attempt(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // Decoration only: the tap's own action runs regardless.
  }
}

/** Selection tick for a row, pill, or tab that changes what is shown. */
export function selectionHaptic(): void {
  void attempt(() => Haptics.selectionAsync());
}

/** Impact feedback for a send, stop, or other deliberate press. */
export function impactHaptic(style: Haptics.ImpactFeedbackStyle): void {
  void attempt(() => Haptics.impactAsync(style));
}

/** Success, warning, or error notice after a completed action. */
export function notificationHaptic(type: Haptics.NotificationFeedbackType): void {
  void attempt(() => Haptics.notificationAsync(type));
}
