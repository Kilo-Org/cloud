import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';

import { NewSessionPrompt } from '@/components/agents/new-session-prompt';

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
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

const PROMPT_PLACEHOLDER = i18n.t('agentChat.newSession.promptPlaceholder');

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

async function mountPrompt(overrides: Partial<PromptProps> = {}): Promise<ReactTestRenderer> {
  const holder: { current?: ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(NewSessionPrompt, makeProps(overrides)));
  });
  if (!holder.current) {
    throw new Error('prompt did not mount');
  }
  return holder.current;
}

/** Type through the input's own handler, the way the native field reports it. */
function typeDraft(renderer: ReactTestRenderer, draft: string) {
  const props = findPromptInput(renderer).props as { onChangeText: (text: string) => void };
  act(() => {
    props.onChangeText(draft);
  });
}

describe('NewSessionPrompt accessible name', () => {
  beforeEach(() => {
    // The catalogs are loaded once; a previous suite cannot change this copy.
    expect(PROMPT_PLACEHOLDER).not.toBe('');
  });

  it('names the empty prompt field with the placeholder copy', async () => {
    const renderer = await mountPrompt();

    const input = findPromptInput(renderer);
    expect(input.props.accessibilityLabel).toBe(PROMPT_PLACEHOLDER);
    expect(input.props.defaultValue).toBeUndefined();

    renderer.unmount();
  });

  it('keeps the name after the draft becomes the field content', async () => {
    const renderer = await mountPrompt();
    const draft = 'Halve the nightly build time';

    typeDraft(renderer, draft);

    const typed = findPromptInput(renderer);
    expect(typed.props.accessibilityLabel).toBe(PROMPT_PLACEHOLDER);
    expect(typed.props.accessibilityLabel).not.toBe(draft);
    // The draft stays the field's value, seeded through the uncontrolled input.
    expect(typed.props.placeholder).toBe(PROMPT_PLACEHOLDER);

    renderer.unmount();
  });

  it('keeps the name when the field holds only whitespace', async () => {
    const renderer = await mountPrompt({ initialPrompt: '   ' });

    const input = findPromptInput(renderer);
    expect(input.props.accessibilityLabel).toBe(PROMPT_PLACEHOLDER);
    expect(input.props.defaultValue).toBe('   ');

    renderer.unmount();
  });
});
