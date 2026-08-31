import { describe, expect, it } from 'vitest';

import '@/i18n';
import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';

describe.each([
  { isUser: true, label: 'User message' },
  { isUser: false, label: 'Assistant message' },
])('message accessibility props for $label', ({ isUser, label }) => {
  it.each([
    { canCopy: true, canOpenDetails: true, actions: ['details', 'copy'] },
    { canCopy: false, canOpenDetails: true, actions: ['details'] },
    { canCopy: true, canOpenDetails: false, actions: ['copy'] },
    { canCopy: false, canOpenDetails: false, actions: [] },
  ])(
    'exposes actions and hints with canCopy=$canCopy canOpenDetails=$canOpenDetails',
    ({ canCopy, canOpenDetails, actions }) => {
      expect(
        buildAgentMessageBubbleAccessibilityProps({ isUser, canCopy, canOpenDetails })
      ).toEqual({
        accessible: false,
        accessibilityRole: 'text',
        accessibilityLabel: label,
        accessibilityHint: canOpenDetails ? 'Long press for message details' : '',
        accessibilityActions: actions.map(name => ({
          name,
          label: name === 'details' ? 'Message details' : 'Copy message',
        })),
      });
    }
  );
});
