import { type AccessibilityActionInfo } from 'react-native';

type MessageBubbleA11yInput = {
  isFromMe: boolean;
  authorLabel: string;
  canSwipeReply: boolean;
  canLongPress: boolean;
};

type MessageBubbleAccessibility = {
  /** Applied to the wrapping `Pressable` so iOS does not collapse the message subtree. */
  accessible: false;
  /** Applied to the dedicated inner actions host (VoiceOver/TalkBack rotor). */
  accessibilityLabel: string;
  /** Applied to the dedicated inner actions host (VoiceOver/TalkBack rotor). */
  accessibilityActions: AccessibilityActionInfo[];
};

/**
 * Builds accessibility props for the kilo-chat `MessageBubble`.
 *
 * Why `accessible: false` on the wrapping `Pressable`:
 *   React Native `Pressable` hard-defaults to `accessible={true}` (see
 *   `react-native/Libraries/Components/Pressable/Pressable.js`). On iOS, an
 *   accessibility element does NOT expose its descendants to VoiceOver swipe
 *   navigation, so the message body `Text`, exec-approval `Button`s, attachment
 *   buttons, reaction pills, and author/timestamp `Text` would all leave the
 *   a11y tree. Setting `accessible={false}` on the wrapper keeps every
 *   descendant individually navigable.
 *
 *   Importantly, setting an explicit `accessibilityLabel` on an accessible
 *   wrapper would also suppress iOS's `RCTRecursiveAccessibilityLabel` co-opting,
 *   so the message body would not be announced anywhere. `accessible={false}`
 *   is the only correct fix; label length is not the mechanism.
 *
 * Why the actions are hosted on a separate inner overlay:
 *   `accessibilityActions` need a focusable element to attach to. We create an
 *   inset-matched, non-interactive, focusable `View` overlay on the bubble that
 *   carries the brief label and the custom reply / more-actions actions. Because
 *   that host is not the wrapper and has no children, it does not swallow the
 *   message subtree while still giving VoiceOver/TalkBack a rotor target. When
 *   no actions are available, the overlay is not rendered at all, so it cannot
 *   become a content-free duplicate focus stop.
 */
export function buildMessageBubbleAccessibilityProps(
  input: MessageBubbleA11yInput
): MessageBubbleAccessibility {
  const label = input.isFromMe ? 'Your message' : `Message from ${input.authorLabel}`;

  const actions: AccessibilityActionInfo[] = [];
  if (input.canSwipeReply) {
    actions.push({ name: 'reply', label: 'Reply' });
  }
  if (input.canLongPress) {
    actions.push({ name: 'more-actions', label: 'More actions' });
  }

  return {
    accessible: false,
    accessibilityLabel: label,
    accessibilityActions: actions,
  };
}
