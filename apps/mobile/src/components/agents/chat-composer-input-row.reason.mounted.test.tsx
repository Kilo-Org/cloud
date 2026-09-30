import { describe, expect, it, vi } from 'vitest';

import { AccessibleStatus } from '@/components/ui/accessible-status';

import {
  findAllByType,
  findByAccessibilityLabel,
  findTextInput,
  renderRow,
} from './chat-composer-input-row.mounted.test-helpers';

// `AccessibleStatus` reads `Platform.OS` at render time: Android renders a
// polite live region, iOS announces imperatively through
// `useStatusAnnouncement`. This suite pins iOS, so the mounted reason Text
// carries no live-region prop; `accessible-status.mounted.test.tsx` covers the
// Android channel.
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

  it('delegates the reason to AccessibleStatus, hints send, keeps the input editable', async () => {
    const props = { inputEditable: true, sendDisabledReason: REASON };
    const renderer = await renderRow(props);
    const [status] = renderer.root.findAllByType(AccessibleStatus);
    expect(status?.props).toMatchObject({ message: REASON, tone: 'error' });
    const reason = findAllByType(renderer.root, 'Text').find(n => n.props.children === REASON);
    expect(reason?.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
    // The row hands the announcement to `AccessibleStatus`, so the reason Text
    // only carries a live region on Android — this iOS render has none.
    expect(reason?.props.accessibilityLiveRegion).toBeUndefined();
    expect(String(reason?.props.className)).toContain('text-destructive');
    const send = findByAccessibilityLabel(renderer.root, 'Send message');
    expect(send?.props.accessibilityHint).toBe(REASON);
    expect(findTextInput(renderer.root).props.editable).toBe(true);
    expect(String(findTextInput(renderer.root).parent?.props.className)).toContain('flex-1');
    renderer.unmount();
  });

  it('paints a neutral reason in the status tone, not the destructive one', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      sendDisabledReason: 'Setting up environment…',
      sendDisabledReasonTone: 'neutral',
    });
    const [status] = renderer.root.findAllByType(AccessibleStatus);
    expect(status?.props.tone).toBe('status');
    const reason = findAllByType(renderer.root, 'Text').find(
      n => n.props.children === 'Setting up environment…'
    );
    expect(String(reason?.props.className)).toContain('text-muted-foreground');
    renderer.unmount();
  });
});
