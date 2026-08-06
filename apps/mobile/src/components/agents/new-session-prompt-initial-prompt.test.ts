import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { ComposerPasteButton } from '@/components/agents/composer-paste-button';

const onChangeTextMock = vi.fn();
const pasteClipboardImageMock = vi.hoisted(() => vi.fn());
/** Captures the options the composer hands the clipboard hint. */
const clipboardHintOptions = vi.hoisted(() => ({
  current: null as { addText?: (text: string) => void } | null,
}));

// ── React hooks (real useEffect needs rendering context, so mock all hooks) ──
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
  };
});

// ── react-native ────────────────────────────────────────────────────
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));

// ── icons ──────────────────────────────────────────────────────────
vi.mock('lucide-react-native', () => ({
  ClipboardPaste: () => null,
  Paperclip: () => null,
}));

vi.mock('sonner-native', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ── sub-components ─────────────────────────────────────────────────
vi.mock('@/components/agents/attachment-preview-strip', () => ({
  AttachmentPreviewStrip: () => null,
}));

vi.mock('@/components/agents/chat-toolbar', () => ({
  ChatToolbar: () => null,
}));

vi.mock('@/components/agents/use-text-height', () => ({
  useTextHeight: () => ({
    height: 48,
    measureElement: null,
    reset: vi.fn(),
    setText: vi.fn(),
  }),
}));

vi.mock('@/components/agents/new-session-prompt-state', () => ({
  resolveNewSessionPromptControlState: () => ({
    createDisabled: false,
    hasPrompt: false,
    inputAccessibilityDisabled: false,
    inputEditable: true,
    paperclipDisabled: false,
    voiceDisabled: false,
  }),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: () => null,
}));

vi.mock('@/components/voice-input-control', () => ({
  VoiceInputButton: () => null,
  VoiceInputStatus: () => null,
}));

// ── hooks ──────────────────────────────────────────────────────────
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

vi.mock('@/lib/agent-attachments/use-clipboard-paste', () => ({
  useClipboardPaste: (options: { addText?: (text: string) => void }) => {
    clipboardHintOptions.current = options;
    return {
      visible: false,
      refresh: vi.fn(),
      paste: pasteClipboardImageMock,
    };
  },
}));

vi.mock('@/lib/share-prefill', () => ({
  useSharePrefill: () => {
    // no-op hook
  },
}));

vi.mock('@/lib/voice-input/use-voice-input', () => ({
  useVoiceInput: () => ({
    abort: vi.fn(),
    available: false,
    isActive: false,
    settleBeforeSubmit: vi.fn(),
    status: 'idle' as const,
    toggle: vi.fn(),
  }),
}));

vi.mock('@/lib/voice-input/voice-input-draft', () => ({
  applyVoiceDraftToInput: vi.fn(),
}));

// ── helpers ────────────────────────────────────────────────────────
type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;
type ElementType = string | ((...args: never[]) => unknown);

function findElementByType(node: Node, target: ElementType): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const nodeType = (node as { type?: unknown }).type;
  if (nodeType === target) {
    return node.props ?? {};
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child as Node, target);
    if (found) {
      return found;
    }
  }
  return null;
}

function defaultProps() {
  const voiceInputSettlerRef: React.RefObject<(() => Promise<boolean>) | null> = {
    current: null,
  };
  return {
    attachments: [] as never[],
    attachmentMax: 5,
    isCreating: false,
    isModelsError: false,
    isLoadingModels: false,
    mode: 'code' as AgentMode,
    model: 'anthropic/claude-sonnet-4',
    variant: 'medium',
    modelOptions: [] as never[],
    onChangeText: onChangeTextMock,
    onModeChange: vi.fn(),
    onModelSelect: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRetryAttachment: vi.fn(),
    onRefetchModels: vi.fn(),
    onPrefillAttachments: vi.fn(),
    voiceInputSettlerRef,
  };
}

describe('NewSessionPrompt initialPrompt seed', () => {
  it('does not invoke onChangeText when initialPrompt seeds the uncontrolled input on mount', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    onChangeTextMock.mockClear();
    // eslint-disable-next-line new-cap -- called as plain function, matching repo test convention
    NewSessionPrompt({
      ...defaultProps(),
      initialPrompt: 'hello world',
    });

    expect(onChangeTextMock).not.toHaveBeenCalled();
  });

  it('seeds defaultValue with initialPrompt text', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionPrompt({
      ...defaultProps(),
      initialPrompt: 'hello world',
    }) as Node;

    const textInputProps = findElementByType(element, 'TextInput');
    expect(textInputProps).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(textInputProps!.defaultValue).toBe('hello world');
  });

  it('fires onChangeText when the user types after mount', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    onChangeTextMock.mockClear();
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionPrompt({
      ...defaultProps(),
      initialPrompt: 'hello world',
    }) as Node;

    const textInputProps = findElementByType(element, 'TextInput');
    expect(textInputProps).not.toBeNull();

    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const handleChange = textInputProps!.onChangeText as ((text: string) => void) | undefined;
    expect(handleChange).toEqual(expect.any(Function));
    handleChange?.('hello world, updated');

    expect(onChangeTextMock).toHaveBeenCalledWith('hello world, updated');
  });

  it('leaves defaultValue undefined when initialPrompt is omitted', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionPrompt(defaultProps()) as Node;

    const textInputProps = findElementByType(element, 'TextInput');
    expect(textInputProps).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(textInputProps!.defaultValue).toBeUndefined();
  });

  it('pastes clipboard text at the reported caret, not at the draft end', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    onChangeTextMock.mockClear();
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionPrompt({
      ...defaultProps(),
      initialPrompt: 'fix the bug',
    }) as Node;

    const textInputProps = findElementByType(element, 'TextInput') ?? {};
    const reportSelection = textInputProps.onSelectionChange as (event: {
      nativeEvent: { selection: { start: number; end: number } };
    }) => void;
    reportSelection({ nativeEvent: { selection: { start: 4, end: 4 } } });

    clipboardHintOptions.current?.addText?.('really ');

    expect(onChangeTextMock).toHaveBeenCalledWith('fix really the bug');
  });

  it('renders the paste button wired to the clipboard hint paste path', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionPrompt(defaultProps()) as Node;

    const pasteButtonProps = findElementByType(element, ComposerPasteButton);
    expect(pasteButtonProps).not.toBeNull();
    const props = pasteButtonProps ?? {};
    expect(props.onPress).toBe(pasteClipboardImageMock);
    expect(props.disabled).toBe(false);
  });
});
