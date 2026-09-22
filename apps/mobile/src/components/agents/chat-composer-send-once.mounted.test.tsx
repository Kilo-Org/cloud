/* eslint-disable max-lines -- the mocked native surface needs one mock block per bridge */
/* eslint-disable require-await, @typescript-eslint/require-await -- mock factories settle without await, matching chat-composer.test.ts */
import * as React from 'react';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './chat-composer';

// Pins the session send contract at the component level: ONE send press sends
// the current draft exactly once, with the keyboard reported open or closed
// and across input focus changes; an empty draft never sends; a second press
// while the first send is in flight is deduplicated. The press invokes the
// mounted Send Pressable's handler after asserting it is not disabled, so the
// full JS submit path (coalescer flush, voice settle, submit lock, admission
// gate, optimistic clear) runs exactly as a device tap reaches it.

// ── native bridges ───────────────────────────────────────────────────────────
const keyboardListeners = vi.hoisted(() => ({
  show: null as ((event: { endCoordinates: { height: number } }) => void) | null,
  hide: null as (() => void) | null,
}));
const keyboardDismiss = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    announceForAccessibility: vi.fn(),
    isReduceTransparencyEnabled: vi.fn(async () => false),
  },
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  I18nManager: { isRTL: false },
  Keyboard: {
    addListener: vi.fn((event: string, handler: never) => {
      if (event === 'keyboardWillShow' || event === 'keyboardDidShow') {
        keyboardListeners.show = handler;
      }
      if (event === 'keyboardWillHide' || event === 'keyboardDidHide') {
        keyboardListeners.hide = handler;
      }
      return { remove: vi.fn() };
    }),
    dismiss: keyboardDismiss,
  },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1, height: 800, scale: 1, width: 400 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  // The dismiss pan is native-device behavior; here the detector passes the
  // row through so the JS submit path runs unmodified.
  Gesture: {
    Pan: () => {
      const builder = {
        runOnJS: () => builder,
        activeOffsetY: () => builder,
        failOffsetX: () => builder,
        enabled: () => builder,
        onStart: () => builder,
      };
      return builder;
    },
  },
  GestureDetector: ({ children }: { children: React.ReactElement }) => children,
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn(() => ({})) },
  FadeOut: { duration: vi.fn(() => ({})) },
}));

vi.mock('@/lib/a11y/motion', () => ({
  selectReducedMotionEntrance: <T,>(reduced: boolean, entrance: T) =>
    reduced ? undefined : entrance,
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ dispatch: vi.fn() }),
}));

vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: vi.fn(),
}));

// ── presentation children ────────────────────────────────────────────────────
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: () => null }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ArrowUp: 'ArrowUp',
  CornerDownLeft: 'CornerDownLeft',
  Paperclip: 'Paperclip',
  Square: 'Square',
}));
vi.mock('@/components/ui/blur-bar', () => ({
  BlurBar: ({ children }: { children: React.ReactElement }) => children,
}));
vi.mock('@/components/agents/attachment-preview-strip', () => ({
  AttachmentPreviewStrip: () => null,
}));
vi.mock('@/components/agents/chat-toolbar', () => ({ ChatToolbar: () => null }));
vi.mock('@/components/agents/slash-command-suggestions', () => ({
  SlashCommandSuggestions: () => null,
}));
vi.mock('@/components/agents/suggestion-card', () => ({ SuggestionCard: () => null }));
vi.mock('@/components/agents/remote-session-exit-alert', () => ({
  showRemoteSessionExitConfirmation: vi.fn(async () => true),
}));
vi.mock('@/components/agents/remote-session-exit-confirmation', () => ({
  confirmRemoteSessionExit: vi.fn(async (_confirm: unknown, run: () => Promise<void>) => run()),
}));
vi.mock('@/components/agents/attachment-picker', () => ({
  pickAgentAttachments: vi.fn(async () => []),
}));
vi.mock('@/components/voice-input-control', () => ({
  VoiceInputButton: 'VoiceInputButton',
  VoiceInputStatus: () => null,
}));

// ── hooks and libs ───────────────────────────────────────────────────────────
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    accentSoftForeground: '#000',
    destructiveForeground: '#f00',
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1', isLoading: false }),
}));

vi.mock('@/lib/hooks/use-return-sends-message-preference', () => ({
  useReturnSendsMessagePreference: () => ({
    returnSendsMessage: false,
    hasLoaded: true,
    setReturnSendsMessage: vi.fn(),
  }),
}));

vi.mock('@/lib/persist/drafts', () => ({
  clearDraft: vi.fn(),
  saveDraft: vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({
  useDraftFlushOnBackground: vi.fn(),
}));
vi.mock('@/lib/share-prefill', () => ({
  useSharePrefill: vi.fn(),
}));

const uploadMock = vi.hoisted(() => ({
  addCandidates: vi.fn(async () => undefined),
  attachments: [] as unknown[],
  clearOptimistic: vi.fn(),
  commitSent: vi.fn(),
  hasFailedAttachments: false,
  isUploading: false,
  moveAttachment: vi.fn(),
  releaseUnclaimedUploads: vi.fn(),
  removeAttachment: vi.fn(),
  reorderAttachments: vi.fn(),
  restoreChips: vi.fn(),
  restoreFileParts: vi.fn(),
  retryAttachment: vi.fn(),
  uploadPending: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('@/lib/agent-attachments/use-agent-attachment-upload', () => ({
  useAgentAttachmentUpload: () => uploadMock,
}));
vi.mock('@/lib/agent-attachments/use-android-pending-picker-recovery', () => ({
  useAndroidPendingPickerRecovery: vi.fn(),
}));
vi.mock('@/lib/agent-attachments/use-clipboard-paste', () => ({
  clipboardPasteEmptyMessage: () => 'Clipboard is empty',
  useClipboardPaste: () => ({ paste: vi.fn() }),
}));

vi.mock('@/lib/voice-input/use-voice-input', () => ({
  useVoiceInput: () => ({
    abort: vi.fn(async () => true),
    available: true,
    isActive: false,
    settleBeforeSubmit: vi.fn(async () => true),
    status: 'idle' as const,
    toggle: vi.fn(async () => undefined),
  }),
}));

// ── harness ──────────────────────────────────────────────────────────────────
function baseProps(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  return {
    activeSessionType: null,
    attachmentsEnabled: false,
    commands: [],
    commandState: null,
    disabled: false,
    isStreaming: false,
    model: 'model-a',
    modelOptions: [],
    mode: 'build' as never,
    onCreateSession: vi.fn(async () => true),
    onExitSession: vi.fn(async () => undefined),
    onModeChange: vi.fn(),
    onModelSelect: vi.fn(),
    onRestartSession: vi.fn(async () => true),
    onSend: vi.fn(async () => undefined),
    onSendCommand: vi.fn(async () => true),
    onStop: vi.fn(async () => undefined),
    variant: '',
    ...overrides,
  };
}

async function mountComposer(
  props: Parameters<typeof ChatComposer>[0]
): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    holder.current = TestRenderer.create(createElement(ChatComposer, props));
  });
  if (holder.current === undefined) {
    throw new Error('renderer was not created');
  }
  return holder.current;
}

type SendControl = { disabled: boolean; press: () => void };

function sendControl(root: TestRenderer.ReactTestInstance, label = 'Send message'): SendControl {
  const matches = root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === label
  );
  const node = matches[0];
  if (node === undefined) {
    throw new Error(`pressable "${label}" not found`);
  }
  const props = node.props as { disabled?: boolean; onPress?: () => void };
  if (props.onPress === undefined) {
    throw new Error(`pressable "${label}" has no onPress`);
  }
  return { disabled: props.disabled === true, press: props.onPress };
}

async function tick(ms = 0): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function findTextInput(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => typeof node.type === 'string' && (node.type as string) === 'TextInput');
}

async function typeIntoComposer(
  renderer: TestRenderer.ReactTestRenderer,
  text: string
): Promise<void> {
  const input = findTextInput(renderer.root);
  await act(async () => {
    (input.props.onChangeText as (value: string) => void)(text);
    // One macrotask publishes the coalesced derived state (hasText, counter).
    await tick();
  });
}

/** Drains the submit chain's macrotask rounds (voice settle → upload → send). */
async function flushSubmitChain(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- each round settles one link of the async submit chain
    await tick();
  }
}

describe('ChatComposer send — one tap sends exactly once', () => {
  beforeEach(() => {
    keyboardListeners.show = null;
    keyboardListeners.hide = null;
    keyboardDismiss.mockClear();
    uploadMock.uploadPending.mockClear();
    uploadMock.uploadPending.mockImplementation(async () => ({ ok: true as const }));
  });

  it('sends the typed message on the first send press, keyboard closed', async () => {
    const onSend = vi.fn(async () => undefined);
    const renderer = await mountComposer(baseProps({ onSend }));

    await typeIntoComposer(renderer, 'hello from the repro');

    const send = sendControl(renderer.root);
    expect(send.disabled).toBe(false);

    await act(async () => {
      send.press();
      await flushSubmitChain();
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello from the repro', expect.anything());

    renderer.unmount();
  });

  it('sends the typed message on the first send press, keyboard open', async () => {
    const onSend = vi.fn(async () => undefined);
    const renderer = await mountComposer(baseProps({ onSend }));

    // Keyboard open: the composer's listener tracks the reported height.
    await act(async () => {
      keyboardListeners.show?.({ endCoordinates: { height: 336 } });
    });
    await typeIntoComposer(renderer, 'typed with the keyboard up');

    const send = sendControl(renderer.root);
    expect(send.disabled).toBe(false);

    await act(async () => {
      send.press();
      await flushSubmitChain();
    });

    expect(onSend).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('sends once across input focus and blur changes before the press', async () => {
    const onSend = vi.fn(async () => undefined);
    const renderer = await mountComposer(baseProps({ onSend }));

    const input = findTextInput(renderer.root);
    await act(async () => {
      (input.props.onFocus as () => void)();
      (input.props.onChangeText as (value: string) => void)('focus changed mid-draft');
      await tick();
      (input.props.onBlur as () => void)();
    });

    const send = sendControl(renderer.root);
    expect(send.disabled).toBe(false);

    await act(async () => {
      send.press();
      await flushSubmitChain();
    });

    expect(onSend).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not send on a press with an empty draft', async () => {
    const onSend = vi.fn(async () => undefined);
    const renderer = await mountComposer(baseProps({ onSend }));

    const send = sendControl(renderer.root);
    expect(send.disabled).toBe(true);

    // Even if the press handler ran, the empty draft must not send.
    await act(async () => {
      send.press();
      await flushSubmitChain();
    });

    expect(onSend).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('ignores a second send press while the first send is in flight', async () => {
    let releaseSend: (() => void) | undefined = undefined;
    const onSend = vi.fn(
      async (): Promise<void> =>
        new Promise(resolve => {
          releaseSend = resolve;
        })
    );
    const renderer = await mountComposer(baseProps({ onSend }));

    await typeIntoComposer(renderer, 'in-flight dedupe');

    const send = sendControl(renderer.root);
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.press();
      // The first send stays pending until releaseSend fires below.
    });

    await act(async () => {
      send.press();
      await flushSubmitChain();
    });

    await act(async () => {
      releaseSend?.();
      await flushSubmitChain();
    });

    expect(onSend).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
