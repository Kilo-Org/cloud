import { type Insets } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { COMPOSER_VOICE_SEND_GAP_CLASS } from '@/lib/a11y/tap-target';
import { type TestRenderer } from '@/test/renderer';

import { COMPOSER_CONTROL_GAP_CLASS } from './chat-composer-input-row';
import {
  findAllByType,
  findByAccessibilityLabel,
  findTextInput,
  renderRow,
} from './chat-composer-input-row.mounted.test-helpers';

const layoutDirection = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: layoutDirection,
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

/**
 * Whether the nearest ancestor carrying `gapClass` has it as one of its class
 * tokens. The input's wrapper spells the same gap beside its own layout
 * classes, so the token is what has to match, not the whole className.
 */
function hasGapWrapper(
  control: TestRenderer.ReactTestInstance | null,
  gapClass = COMPOSER_CONTROL_GAP_CLASS
): boolean {
  let current = control?.parent ?? null;
  while (current !== null) {
    const className: unknown = current.props.className;
    if (typeof className === 'string' && className.split(/\s+/).includes(gapClass)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function hitSlopOf(control: TestRenderer.ReactTestInstance | null | undefined): Insets {
  return control?.props.hitSlop as Insets;
}

describe('ChatComposerInputRow mounted — control separation', () => {
  // The reported defect: the send/stop control carried no gap at all, so it
  // rendered flush against the microphone as a single shape with overlapping
  // tap areas (spot check e1 / e1-en-two-msg). The input and the controls
  // after it carry the row gap; the send/stop control after the microphone
  // carries the narrower voice/send gap instead.
  it('wraps the input, the voice toggle and the newline control in the row gap', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      returnSendsMessage: true,
      voiceInputAvailable: true,
    });

    const [mic] = findAllByType(renderer.root, 'VoiceInputButton');
    expect(findByAccessibilityLabel(renderer.root, 'Insert newline')).not.toBeNull();
    for (const control of [
      findTextInput(renderer.root),
      mic ?? null,
      findByAccessibilityLabel(renderer.root, 'Insert newline'),
    ]) {
      expect(hasGapWrapper(control)).toBe(true);
    }

    renderer.unmount();
  });

  // The row mirrors under RTL, so the gap has to be a start-side margin: a
  // physical `ml-`/`mr-` gap would land on the wrong side of the mirrored
  // control and leave it flush against its neighbour (spot check
  // e1-rtl-session showed the mirrored microphone and send circle merged).
  it('gaps the controls with a logical start margin so the row stays spaced under RTL', () => {
    expect(COMPOSER_CONTROL_GAP_CLASS).toMatch(/^ms-\d/);
    expect(COMPOSER_VOICE_SEND_GAP_CLASS).toMatch(/^ms-\d/);
  });

  // The voice/send gap is narrower than the two facing slops, so each control
  // drops the slop on the side it faces the other on, or a tap on the
  // microphone's edge would send the message.
  it.each([
    { isRTL: false, micFacing: 'right', sendFacing: 'left' },
    { isRTL: true, micFacing: 'left', sendFacing: 'right' },
  ] as const)(
    'zeroes the mic and send slops on their facing sides (RTL: $isRTL)',
    async ({ isRTL, micFacing, sendFacing }) => {
      layoutDirection.isRTL = isRTL;
      try {
        const renderer = await renderRow({ inputEditable: true, voiceInputAvailable: true });

        const [mic] = findAllByType(renderer.root, 'VoiceInputButton');
        const send = findByAccessibilityLabel(renderer.root, 'Send message');
        expect(hasGapWrapper(send, COMPOSER_VOICE_SEND_GAP_CLASS)).toBe(true);
        expect(hitSlopOf(mic)[micFacing]).toBe(0);
        expect(hitSlopOf(mic)[sendFacing]).toBeGreaterThan(0);
        expect(hitSlopOf(send)[sendFacing]).toBe(0);
        expect(hitSlopOf(send)[micFacing]).toBeGreaterThan(0);

        renderer.unmount();
      } finally {
        layoutDirection.isRTL = false;
      }
    }
  );

  it('keeps the row gap and full slop on send when no mic sits before it', async () => {
    const renderer = await renderRow({ inputEditable: true, voiceInputAvailable: false });

    const send = findByAccessibilityLabel(renderer.root, 'Send message');
    expect(hasGapWrapper(send)).toBe(true);
    expect(send?.props.hitSlop).toBeGreaterThan(0);

    renderer.unmount();
  });

  it('wraps the stop control in the voice/send gap while streaming', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
      voiceInputAvailable: true,
    });

    const [mic] = findAllByType(renderer.root, 'VoiceInputButton');
    const stop = findByAccessibilityLabel(renderer.root, 'Stop generating');
    expect(stop).not.toBeNull();
    expect(hasGapWrapper(mic ?? null)).toBe(true);
    expect(hasGapWrapper(stop, COMPOSER_VOICE_SEND_GAP_CLASS)).toBe(true);
    expect(hitSlopOf(stop).left).toBe(0);

    renderer.unmount();
  });
});
