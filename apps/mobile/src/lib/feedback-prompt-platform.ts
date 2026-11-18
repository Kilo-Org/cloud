import { Platform } from 'react-native';

/**
 * Whether the one-time feedback prompt needs the in-app `FeedbackPromptDialog`
 * instead of `Alert.alert`.
 *
 * React Native always hands the Android dialog a message — `Alert.alert` builds
 * its config as `message: message || ''` — and the AppCompat dialog keeps that
 * (now empty) message band between the title and the actions. With three
 * actions the panel reads as a title at the top, a large void, and the actions
 * adrift at the bottom. The band cannot be filled by the prompt's copy without
 * adding a new English key, which `tools/i18n/check-catalogs.mjs` requires in
 * every catalog, so Android renders the in-app dialog instead. iOS honors the
 * same call and keeps the native alert.
 *
 * The platform read lives in this module rather than in the screens because
 * their tests hold them to one platform-agnostic implementation (the same shape
 * as `destructive-confirm-platform.ts`).
 */
export function needsInAppFeedbackPrompt(): boolean {
  return Platform.OS === 'android';
}
