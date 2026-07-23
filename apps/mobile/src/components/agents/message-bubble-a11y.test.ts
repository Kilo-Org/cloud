import { describe, expect, it } from 'vitest';

import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';

describe('buildAgentMessageBubbleAccessibilityProps', () => {
  it('marks the wrapping Pressable as non-accessible so the message subtree stays navigable', () => {
    const props = buildAgentMessageBubbleAccessibilityProps({
      isUser: true,
      canCopy: true,
    });

    expect(props.accessible).toBe(false);
  });

  it('labels user-authored messages consistently with the previous role/label', () => {
    const props = buildAgentMessageBubbleAccessibilityProps({
      isUser: true,
      canCopy: true,
    });

    expect(props.accessibilityLabel).toBe('User message');
  });

  it('labels assistant-authored messages consistently with the previous role/label', () => {
    const props = buildAgentMessageBubbleAccessibilityProps({
      isUser: false,
      canCopy: true,
    });

    expect(props.accessibilityLabel).toBe('Assistant message');
  });

  it('keeps the long-press hint and the text role on the inner actions host', () => {
    const props = buildAgentMessageBubbleAccessibilityProps({
      isUser: false,
      canCopy: true,
    });

    expect(props.accessibilityRole).toBe('text');
    expect(props.accessibilityHint).toBe('Long press to copy message text');
  });

  it('exposes the copy custom action with the same name and label as before', () => {
    const props = buildAgentMessageBubbleAccessibilityProps({
      isUser: true,
      canCopy: true,
    });

    expect(props.accessibilityActions).toEqual([{ name: 'copy', label: 'Copy message' }]);
  });

  it('omits the copy action when the caller disables it so the inner host can be left out', () => {
    const props = buildAgentMessageBubbleAccessibilityProps({
      isUser: false,
      canCopy: false,
    });

    expect(props.accessibilityActions).toEqual([]);
  });
});
