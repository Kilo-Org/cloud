import { type AccessibilityActionInfo } from 'react-native';

import { i18n } from '@/i18n';

/**
 * Accessibility contract applied to the agent `MessageBubble` subtree.
 *
 * Why the wrapper is `accessible: false`:
 *   `Pressable` hard-defaults to `accessible={true}`. On iOS, an accessible
 *   container does not expose its descendants to VoiceOver swipe navigation,
 *   so interactive children — permission-card `Button`s, question-card
 *   `Button`s, the child-session "open" `Pressable`, markdown link handlers,
 *   tool cards, file parts — would all leave the a11y tree while a single
 *   "Assistant message" leaf absorbed the whole subtree. Setting an explicit
 *   label on the wrapper would also suppress iOS's
 *   `RCTRecursiveAccessibilityLabel` co-opting, so the message body would not
 *   be announced anywhere. `accessible={false}` is the only correct fix.
 *
 * Why the role/label/hint/actions live on a separate inner overlay:
 *   `accessibilityActions` need a focusable element to attach to. The overlay
 *   is an inset-matched, non-interactive, focusable `View` with no children,
 *   so it does not swallow the message subtree while still giving the rotor a
 *   target aligned with the bubble's actual bounds. The caller must only render
 *   this host when `accessibilityActions` is non-empty; when the copy action is
 *   not exposed the overlay is omitted so VoiceOver/TalkBack do not stop on an
 *   empty focusable node.
 */
type AgentMessageBubbleAccessibility = {
  /** Applied to the wrapping `Pressable` so the message subtree stays navigable. */
  accessible: false;
  /** Applied to the dedicated inner actions host (VoiceOver/TalkBack rotor). */
  accessibilityLabel: string;
  /** Applied to the dedicated inner actions host. */
  accessibilityHint: string;
  /** Applied to the dedicated inner actions host. */
  accessibilityRole: 'text';
  /** Applied to the dedicated inner actions host. */
  accessibilityActions: AccessibilityActionInfo[];
};

type AgentMessageBubbleA11yInput = {
  /** True for user-authored messages, false for assistant-authored ones. */
  isUser: boolean;
  /** Whether the copy custom action should be exposed. */
  canCopy: boolean;
};

export function buildAgentMessageBubbleAccessibilityProps(
  input: AgentMessageBubbleA11yInput
): AgentMessageBubbleAccessibility {
  const accessibilityLabel = input.isUser
    ? i18n.t('agentChat.messageBubble.userMessage')
    : i18n.t('agentChat.messageBubble.assistantMessage');
  // Long-press opens the message-details sheet; copy remains available only
  // through the rotor custom action below.
  const accessibilityHint = i18n.t('agentChat.messageBubble.longPressHint');
  const accessibilityActions: AccessibilityActionInfo[] = input.canCopy
    ? [{ name: 'copy', label: i18n.t('agentChat.messageDetails.copyMessage') }]
    : [];

  return {
    accessible: false,
    accessibilityLabel,
    accessibilityHint,
    accessibilityRole: 'text',
    accessibilityActions,
  };
}
