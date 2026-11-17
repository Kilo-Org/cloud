import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';

import {
  NEW_SESSION_PROMPT_DEFAULT_LINES,
  NEW_SESSION_PROMPT_LINE_HEIGHT,
  resolveNewSessionPromptHeight,
} from '@/components/agents/chat-composer-input-height';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';

/**
 * The platform the component reads at render. The input's scroll gate is the
 * reported content height on Android and unconditional on iOS, so each case
 * picks the platform before it mounts.
 */
const platform = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  I18nManager: { isRTL: false },
  Platform: platform,
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1, height: 891, scale: 2.625, width: 411 }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  createAnimatedComponent: (component: unknown) => component,
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  useAnimatedStyle: (factory: () => object) => factory(),
  useSharedValue: <T,>(value: T) => ({ value }),
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({
  ClipboardPaste: () => null,
  CornerDownLeft: () => null,
  Paperclip: () => null,
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/voice-input-control', () => ({
  VoiceInputButton: () => null,
  VoiceInputStatus: () => null,
}));
vi.mock('@/components/agents/attachment-preview-strip', () => ({
  AttachmentPreviewStrip: 'AttachmentPreviewStrip',
}));
vi.mock('@/components/agents/chat-toolbar', () => ({ ChatToolbar: 'ChatToolbar' }));
vi.mock('@/components/agents/new-session-prompt-controls', () => ({
  NewSessionPromptControls: 'NewSessionPromptControls',
}));
vi.mock('@/components/agents/new-session-prompt-clone', () => ({
  NewSessionPromptClone: 'NewSessionPromptClone',
}));
vi.mock('@/components/agents/share-prefill-failure', () => ({
  SharePrefillFailure: 'SharePrefillFailure',
}));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    card: '#ffffff',
    foreground: '#000000',
    mutedForeground: '#666666',
    primaryForeground: '#ffffff',
  }),
}));

vi.mock('@/lib/hooks/use-return-sends-message-preference', () => ({
  useReturnSendsMessagePreference: () => ({
    hasLoaded: true,
    returnSendsMessage: false,
    setReturnSendsMessage: vi.fn(),
  }),
}));

vi.mock('@/lib/share-prefill', () => ({
  useSharePrefill: () => ({ dismiss: vi.fn(), failed: false, retry: vi.fn() }),
}));

vi.mock('@/lib/voice-input/use-voice-input', () => ({
  useVoiceInput: () => ({
    abort: vi.fn(),
    available: false,
    isActive: false,
    settleBeforeSubmit: vi.fn(),
    status: 'idle',
    toggle: vi.fn(),
  }),
}));

vi.mock('@/lib/voice-input/voice-input-draft', () => ({
  applyVoiceDraftAtSelection: vi.fn(),
}));

vi.mock('@/lib/agent-attachments/use-clipboard-paste', () => ({
  clipboardPasteFailureMessage: () => '',
  useClipboardPaste: () => ({ paste: vi.fn(), refresh: vi.fn(), visible: false }),
}));

/** The field's own height with no frame measurement: the three-line floor. */
const PROMPT_HEIGHT = resolveNewSessionPromptHeight(
  NEW_SESSION_PROMPT_LINE_HEIGHT,
  NEW_SESSION_PROMPT_DEFAULT_LINES
);

type PromptProps = Parameters<typeof NewSessionPrompt>[0];

function noop() {
  return undefined;
}

function makeProps(overrides: Partial<PromptProps> = {}): PromptProps {
  return {
    attachmentMax: 5,
    attachments: [],
    isCreating: false,
    isLoadingModels: false,
    isModelsError: false,
    mode: 'code',
    model: 'anthropic/claude-sonnet-4',
    modelOptions: [],
    onChangeText: noop,
    onAddAttachment: noop,
    onModeChange: noop,
    onModelSelect: noop,
    onMoveAttachment: noop,
    onPrefillAttachments: () => Promise.resolve(),
    onRefetchModels: noop,
    onRemoveAttachment: noop,
    onReorderAttachments: noop,
    onRetryAttachment: noop,
    variant: 'medium',
    voiceInputSettlerRef: { current: null },
    ...overrides,
  };
}

/** The prompt surface's one editable field, found by its own character cap. */
function findPromptInput(renderer: ReactTestRenderer) {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'TextInput' &&
      node.props.maxLength === CLOUD_AGENT_PROMPT_MAX_LENGTH
  );
}

async function mountPrompt(): Promise<ReactTestRenderer> {
  const holder: { current?: ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(NewSessionPrompt, makeProps()));
  });
  if (!holder.current) {
    throw new Error('prompt did not mount');
  }
  return holder.current;
}

/** Report the draft's laid-out height the way the native field does. */
function reportContentHeight(renderer: ReactTestRenderer, height: number) {
  const props = findPromptInput(renderer).props as {
    onContentSizeChange: (event: { nativeEvent: { contentSize: { height: number } } }) => void;
  };
  act(() => {
    props.onContentSizeChange({ nativeEvent: { contentSize: { height } } });
  });
}

describe('NewSessionPrompt input scroll gate', () => {
  beforeEach(() => {
    platform.OS = 'ios';
  });

  it('scrolls the iOS field before any content size report', async () => {
    const renderer = await mountPrompt();

    // Fabric reports the content size only when the field's frame changes, and
    // this field's frame does not change while the user types.
    expect(findPromptInput(renderer).props.scrollEnabled).toBe(true);

    renderer.unmount();
  });

  it('keeps the Android field fixed until the draft reaches the field height', async () => {
    platform.OS = 'android';
    const renderer = await mountPrompt();

    expect(findPromptInput(renderer).props.scrollEnabled).toBe(false);

    reportContentHeight(renderer, PROMPT_HEIGHT - 1);
    expect(findPromptInput(renderer).props.scrollEnabled).toBe(false);

    reportContentHeight(renderer, PROMPT_HEIGHT);
    expect(findPromptInput(renderer).props.scrollEnabled).toBe(true);

    renderer.unmount();
  });
});
