import { describe, expect, it } from 'vitest';

import { buildMessageBubbleAccessibilityProps } from './message-bubble-a11y';

describe('buildMessageBubbleAccessibilityProps', () => {
  it('marks the wrapping Pressable as non-accessible so the message subtree stays navigable', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: true,
      authorLabel: 'Igor',
      canSwipeReply: true,
      canLongPress: true,
    });

    expect(props.accessible).toBe(false);
  });

  it('announces own messages without naming the recipient', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: true,
      authorLabel: 'Igor',
      canSwipeReply: true,
      canLongPress: true,
    });

    expect(props.accessibilityLabel).toBe('Your message');
  });

  it('prefixes incoming messages with the resolved author label', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: false,
      authorLabel: 'KiloClaw',
      canSwipeReply: true,
      canLongPress: true,
    });

    expect(props.accessibilityLabel).toBe('Message from KiloClaw');
  });

  it('exposes both reply and more-actions when the gestures are wired', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: false,
      authorLabel: 'Helper Bot',
      canSwipeReply: true,
      canLongPress: true,
    });

    const actionNames = props.accessibilityActions.map(action => action.name);
    expect(actionNames).toEqual(expect.arrayContaining(['reply', 'more-actions']));
    expect(props.accessibilityActions.find(action => action.name === 'reply')?.label).toBe('Reply');
    expect(props.accessibilityActions.find(action => action.name === 'more-actions')?.label).toBe(
      'More actions'
    );
  });

  it('omits the reply action when swipe-reply is not available for the message', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: false,
      authorLabel: 'Helper Bot',
      canSwipeReply: false,
      canLongPress: true,
    });

    const actionNames = props.accessibilityActions.map(action => action.name);
    expect(actionNames).not.toContain('reply');
    expect(actionNames).toContain('more-actions');
  });

  it('omits the more-actions action when no long-press callback is wired', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: true,
      authorLabel: 'Igor',
      canSwipeReply: true,
      canLongPress: false,
    });

    const actionNames = props.accessibilityActions.map(action => action.name);
    expect(actionNames).toEqual(['reply']);
  });

  it('returns no accessibility actions for a fully inert message', () => {
    const props = buildMessageBubbleAccessibilityProps({
      isFromMe: true,
      authorLabel: 'Igor',
      canSwipeReply: false,
      canLongPress: false,
    });

    // The bubble wrapper is still accessible={false} so the inner text/buttons
    // remain navigable. The actions host is not rendered at all when actions
    // is empty, so it cannot become a content-free duplicate VoiceOver stop.
    expect(props.accessible).toBe(false);
    expect(props.accessibilityLabel).toBe('Your message');
    expect(props.accessibilityActions).toEqual([]);
  });
});

/*
 * Structural guarantee: the wrapping `Pressable` gets `accessible={false}` and
 * the label/actions are hosted on a dedicated, non-interactive `View` overlay
 * (`accessible={true}`, no children, `pointerEvents="none"`, `absolute inset-0`,
 * `opacity-0`) that is only rendered when `accessibilityActions` is non-empty.
 * This keeps the message body, exec-approval buttons, reaction pills, and
 * attachment buttons outside the collapsed VoiceOver node and still gives the
 * rotor a focusable target aligned with the bubble's actual bounds.
 *
 * The exact iOS/tvOS behavior — whether an opacity-0 overlay remains
 * focusable and whether the navigation order avoids double-announcement — can
 * only be verified on a real device or simulator with VoiceOver running. Unit
 * tests here cover the prop contract; the visual/accessibility tree layout must
 * be confirmed with an on-device pass (Maestro + VoiceOver or Accessibility
 * Inspector).
 */
