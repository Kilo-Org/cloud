import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findAllByType,
  findByAccessibilityLabel,
  findTextInput,
  renderRow,
  renderRowAfterPlatformFlip,
} from './chat-composer-input-row.mounted.test-helpers';

const platformOS = vi.hoisted(() => ({ os: 'ios' }));

function reactNativeMock() {
  return {
    ActivityIndicator: 'ActivityIndicator',
    I18nManager: { isRTL: false },
    Platform: { OS: platformOS.os },
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    View: 'View',
  };
}

vi.mock('react-native', reactNativeMock);
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

describe('ChatComposerInputRow mounted — iOS writing-tools lock', () => {
  beforeEach(() => {
    platformOS.os = 'ios';
  });

  it('blocks writing tools and selection when the input is not editable', async () => {
    const renderer = await renderRow({ inputEditable: false });

    const input = findTextInput(renderer.root);
    expect(input.props.editable).toBe(false);
    expect(input.props.contextMenuHidden).toBe(true);
    expect(input.props.pointerEvents).toBe('none');

    renderer.unmount();
  });

  it('leaves the input editable and gesture-enabled when it is editable', async () => {
    const renderer = await renderRow({ inputEditable: true });

    const input = findTextInput(renderer.root);
    expect(input.props.editable).toBe(true);
    expect(
      input.props.contextMenuHidden === undefined || input.props.contextMenuHidden === false
    ).toBe(true);
    expect(input.props.pointerEvents).not.toBe('none');

    renderer.unmount();
  });

  it('shows the Send pressable (not Stop) while streaming with content and an in-flight upload', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: true,
    });

    expect(findByAccessibilityLabel(renderer.root, 'Send message')).not.toBeNull();
    expect(findByAccessibilityLabel(renderer.root, 'Stop generating')).toBeNull();

    renderer.unmount();
  });

  it('shows the Stop pressable while streaming with no content', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
    });

    expect(findByAccessibilityLabel(renderer.root, 'Stop generating')).not.toBeNull();
    expect(findByAccessibilityLabel(renderer.root, 'Send message')).toBeNull();

    renderer.unmount();
  });

  it('keeps the microphone mounted beside Stop while streaming', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
    });

    expect(findAllByType(renderer.root, 'VoiceInputButton')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Stop generating')).not.toBeNull();

    renderer.unmount();
  });

  it('renders the newline control and wires return-submit when Return sends', async () => {
    const onSubmit = vi.fn<() => void>();
    const renderer = await renderRow({
      inputEditable: true,
      returnSendsMessage: true,
      onSubmit,
    });

    expect(findAllByType(renderer.root, 'CornerDownLeft')).toHaveLength(1);
    expect(findByAccessibilityLabel(renderer.root, 'Insert newline')).not.toBeNull();

    const input = findTextInput(renderer.root);
    expect(input.props.returnKeyType).toBe('send');
    expect(input.props.submitBehavior).toBe('submit');

    (input.props.onSubmitEditing as () => void)();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('omits the newline control and keeps newline submit when Return does not send', async () => {
    const renderer = await renderRow({ inputEditable: true, returnSendsMessage: false });

    expect(findAllByType(renderer.root, 'CornerDownLeft')).toHaveLength(0);

    const input = findTextInput(renderer.root);
    expect(input.props.returnKeyType).toBe('default');
    expect(input.props.submitBehavior).toBe('newline');
    expect(input.props.onSubmitEditing).toBeUndefined();

    renderer.unmount();
  });

  it('sizes the send and stop pressables to the 44pt iOS hit target', async () => {
    const sendRenderer = await renderRow({ inputEditable: true });
    const send = findByAccessibilityLabel(sendRenderer.root, 'Send message');
    const sendStyle = send?.props.style as { height: number; width: number } | undefined;
    expect(sendStyle?.height).toBe(44);
    expect(sendStyle?.width).toBe(44);
    sendRenderer.unmount();

    const stopRenderer = await renderRow({
      inputEditable: true,
      isStreaming: true,
      canSend: false,
      hasSendableContent: false,
    });
    const stop = findByAccessibilityLabel(stopRenderer.root, 'Stop generating');
    const stopStyle = stop?.props.style as { height: number; width: number } | undefined;
    expect(stopStyle?.height).toBe(44);
    expect(stopStyle?.width).toBe(44);
    stopRenderer.unmount();
  });

  it('sizes the send and stop pressables to the 48dp Android hit target', async () => {
    platformOS.os = 'android';

    const sendRenderer = await renderRowAfterPlatformFlip({ inputEditable: true }, reactNativeMock);
    const send = findByAccessibilityLabel(sendRenderer.root, 'Send message');
    const sendStyle = send?.props.style as { height: number; width: number } | undefined;
    expect(sendStyle?.height).toBe(48);
    expect(sendStyle?.width).toBe(48);
    sendRenderer.unmount();

    const stopRenderer = await renderRowAfterPlatformFlip(
      {
        inputEditable: true,
        isStreaming: true,
        canSend: false,
        hasSendableContent: false,
      },
      reactNativeMock
    );
    const stop = findByAccessibilityLabel(stopRenderer.root, 'Stop generating');
    const stopStyle = stop?.props.style as { height: number; width: number } | undefined;
    expect(stopStyle?.height).toBe(48);
    expect(stopStyle?.width).toBe(48);
    stopRenderer.unmount();
  });
});

describe('ChatComposerInputRow mounted — framework suggestions', () => {
  // Android attaches a `SuggestionSpan` only for an input type that allows
  // suggestions, and its pending popup re-applies span bounds against the
  // text after the app replaces it (`setNativeProps({text})` paste, voice
  // draft, clear-on-send), which throws on the main thread. The composer is
  // rewritten this way, so Android must ask for no suggestions; iOS keeps the
  // framework's suggestions because it has no such popup.
  it('asks Android for no suggestions on the rewritten composer', async () => {
    platformOS.os = 'android';

    const renderer = await renderRowAfterPlatformFlip({ inputEditable: true }, reactNativeMock);

    expect(findTextInput(renderer.root).props.autoCorrect).toBe(false);

    renderer.unmount();
  });

  it('keeps the framework suggestions on iOS', async () => {
    const renderer = await renderRow({ inputEditable: true });

    expect(findTextInput(renderer.root).props.autoCorrect).toBe(true);

    renderer.unmount();
  });
});

describe('ChatComposerInputRow mounted — single-line placeholder', () => {
  it('draws the placeholder as a one-line overlay instead of the native hint', async () => {
    const renderer = await renderRow({
      inputEditable: true,
      placeholder: "Configuration de l'environnement…",
    });

    // The native hint has no line cap on Android, so it wrapped onto a second
    // line that the field's height clipped against its border.
    const input = findTextInput(renderer.root);
    expect(input.props.placeholder).toBeUndefined();

    const overlay = renderer.root.findByProps({
      children: "Configuration de l'environnement…",
    });
    expect(overlay.props.numberOfLines).toBe(1);
    expect(overlay.props.ellipsizeMode).toBe('tail');
    expect(overlay.props.pointerEvents).toBe('none');
    // Screens readers get the name from the input, not a decorative overlay.
    expect(overlay.props.accessible).toBe(false);
    expect(input.props.accessibilityLabel).toBe("Configuration de l'environnement…");
    // Pinned under the input so the first keystroke paints over it.
    const siblings = renderer.root
      .findAll(node => typeof node.type === 'string' && (node.type as string) === 'View')
      .flatMap(view => view.children);
    const overlayIndex = siblings.indexOf(overlay);
    expect(overlayIndex).toBeGreaterThanOrEqual(0);
    expect(overlayIndex).toBeLessThan(siblings.indexOf(input));

    renderer.unmount();
  });

  it('hides the overlay once the input holds text', async () => {
    const renderer = await renderRow({ inputEditable: true, inputEmpty: false });

    const hintCopy = findAllByType(renderer.root, 'Text').filter(
      node => node.props.children === 'Message the agent'
    );
    expect(hintCopy).toHaveLength(0);
    // The accessible name survives the missing hint.
    expect(findTextInput(renderer.root).props.accessibilityLabel).toBe('Message the agent');

    renderer.unmount();
  });
});

describe('ChatComposerInputRow mounted — send control surface', () => {
  // The send circle is the row's only filled control, and its dark fill must
  // stay a visible disc on the near-black composer bar: the muted neutral sits
  // within 1.2:1 of that bar, the idle-control surface clears it. The enabled
  // state keeps the accent fill, so the two states stay distinct.
  it('paints the idle control surface while there is nothing to send', async () => {
    const renderer = await renderRow({ inputEditable: true, canSend: false });

    const send = findByAccessibilityLabel(renderer.root, 'Send message');
    expect(send?.props.className).toContain('bg-control-idle');
    expect(send?.props.className).not.toContain('bg-accent-soft');
  });

  it('paints the accent surface once the input can send', async () => {
    const renderer = await renderRow({ inputEditable: true, canSend: true });

    const send = findByAccessibilityLabel(renderer.root, 'Send message');
    expect(send?.props.className).toContain('bg-accent-soft');
  });
});
