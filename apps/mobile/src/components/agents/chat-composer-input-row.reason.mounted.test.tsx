import { describe, expect, it, vi } from 'vitest';

import { AccessibleStatus } from '@/components/ui/accessible-status';

import {
  findByAccessibilityLabel,
  findTextInput,
  renderRow,
} from './chat-composer-input-row.mounted.test-helpers';

// The cannot-send reason moved to the fixed footer row above the composer
// (`session-detail-content.tsx`), which owns its tone, font-scale cap and
// wrapping. This suite pins the row's half of the split: the reason never
// renders inside the composer, and the input keeps hinting it so the reader
// hears why the control is gated.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn(() => ({})) },
  FadeOut: { duration: vi.fn(() => ({})) },
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ArrowUp: 'ArrowUp',
  CornerDownLeft: 'CornerDownLeft',
  Paperclip: 'Paperclip',
  Square: 'Square',
}));
vi.mock('@/components/voice-input-control', () => ({
  VoiceInputButton: 'VoiceInputButton',
}));
vi.mock('@/components/agents/chat-composer-input-height', () => ({
  shouldEnableComposerInputScroll: () => false,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6b7280' }),
}));

describe('ChatComposerInputRow mounted — cannot-send reason', () => {
  const REASON = 'The session could not be loaded. Retry first.';

  it('keeps the reason out of the composer row and hints it on the send control', async () => {
    const renderer = await renderRow({ inputEditable: true, sendDisabledReason: REASON });
    // The row sits inside the composer the reason used to resize; the fixed
    // footer row above the composer is its only surface now.
    expect(renderer.root.findAllByType(AccessibleStatus)).toHaveLength(0);
    const send = findByAccessibilityLabel(renderer.root, 'Send message');
    expect(send?.props.accessibilityHint).toBe(REASON);
    expect(findTextInput(renderer.root).props.editable).toBe(true);
    renderer.unmount();
  });

  it('leaves the row without a reason surface when the host knows no reason', async () => {
    const renderer = await renderRow({ inputEditable: true, sendDisabledReason: null });
    expect(renderer.root.findAllByType(AccessibleStatus)).toHaveLength(0);
    expect(findByAccessibilityLabel(renderer.root, 'Send message')?.props.accessibilityHint).toBe(
      undefined
    );
    renderer.unmount();
  });
});
