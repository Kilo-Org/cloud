/* eslint-disable max-lines -- The shared native hook mocks support prompt seeding and merged control-order regression coverage in one suite. */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { ComposerPasteButton } from '@/components/agents/composer-paste-button';
import { NewSessionPromptControls as renderPromptControls } from '@/components/agents/new-session-prompt-controls';
import { Text as renderText } from '@/components/ui/text';
import { VoiceInputButton, VoiceInputStatus } from '@/components/voice-input-control';

import '@/i18n';
import * as ReactI18next from 'react-i18next';

const layoutDirection = vi.hoisted(() => ({ isRTL: false }));
const TEXT_DIRECTIONS = [
  { direction: 'LTR', isRTL: false, style: undefined },
  { direction: 'RTL', isRTL: true, style: [{ writingDirection: 'rtl' }, undefined] },
];

vi.mock('@rn-primitives/slot', () => ({ Text: 'SlotText' }));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

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
    useContext: vi.fn(() => undefined),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useState: vi.fn(
      <T>(initial: T | (() => T)) =>
        [
          typeof initial === 'function' ? (initial as () => T)() : initial,
          vi.fn() as () => void,
        ] as [T, (value: T) => void]
    ),
  };
});

// ── react-native ────────────────────────────────────────────────────
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
  },
  Keyboard: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  I18nManager: layoutDirection,
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  useWindowDimensions: () => ({ fontScale: 1, height: 800, scale: 1, width: 400 }),
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

// ── icons ──────────────────────────────────────────────────────────
vi.mock('@/components/ui/icons', () => ({
  ClipboardPaste: () => null,
  CornerDownLeft: () => null,
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

vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: () => null,
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

const voiceInputAvailable = vi.hoisted(() => ({ current: false }));

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

const returnSendsMessage = vi.hoisted(() => ({ current: false }));

vi.mock('@/lib/hooks/use-return-sends-message-preference', () => ({
  useReturnSendsMessagePreference: () => ({
    returnSendsMessage: returnSendsMessage.current,
    hasLoaded: true,
    setReturnSendsMessage: vi.fn(),
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
    available: voiceInputAvailable.current,
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

function findElementByType(
  node: Node,
  target: ElementType,
  accessibilityLabel?: string
): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const nodeType = (node as { type?: unknown }).type;
  if (
    nodeType === target &&
    (accessibilityLabel === undefined || props.accessibilityLabel === accessibilityLabel)
  ) {
    return node.props ?? {};
  }
  if (nodeType === renderText) {
    return findElementByType(
      renderText(props as React.ComponentProps<typeof renderText>),
      target,
      accessibilityLabel
    );
  }
  if (nodeType === renderPromptControls) {
    return findElementByType(
      renderPromptControls(props as React.ComponentProps<typeof renderPromptControls>),
      target,
      accessibilityLabel
    );
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child as Node, target, accessibilityLabel);
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
    onMoveAttachment: vi.fn(),
    onReorderAttachments: vi.fn(),
    onRefetchModels: vi.fn(),
    onPrefillAttachments: vi.fn(),
    voiceInputSettlerRef,
  };
}

describe('NewSessionPrompt initialPrompt seed', () => {
  beforeEach(() => {
    voiceInputAvailable.current = false;
    returnSendsMessage.current = false;
    layoutDirection.isRTL = false;
  });

  it.each(TEXT_DIRECTIONS)(
    'shows the seeded counter and its accessible label only near the limit in $direction',
    async ({ isRTL, style }) => {
      const { NewSessionPrompt: renderPrompt } = await import('./new-session-prompt');
      layoutDirection.isRTL = isRTL;
      const shortSeed = renderPrompt({ ...defaultProps(), initialPrompt: 'hello' });
      expect(findElementByType(shortSeed, 'Text', '99995 characters remaining')).toBeNull();

      const element = renderPrompt({
        ...defaultProps(),
        initialPrompt: 'x'.repeat(100_000 - 5),
      });
      expect(findElementByType(element, 'Text', '5 characters remaining')).toMatchObject({
        children: 5,
        className: 'text-xs font-normal text-muted-foreground',
        style,
      });
    }
  );

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

  it('drops a paste that resolves after the input stopped accepting text', async () => {
    const { NewSessionPrompt } = await import('./new-session-prompt');

    onChangeTextMock.mockClear();
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    NewSessionPrompt({ ...defaultProps(), initialPrompt: 'fix the bug', isCreating: true });

    clipboardHintOptions.current?.addText?.('really ');

    expect(onChangeTextMock).not.toHaveBeenCalled();
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

  it.each([
    { isCreating: false, attachmentMax: 5, voiceAvailable: false, paperclipDisabled: false },
    { isCreating: false, attachmentMax: 0, voiceAvailable: true, paperclipDisabled: true },
    { isCreating: true, attachmentMax: 5, voiceAvailable: true, paperclipDisabled: true },
  ])('preserves control availability and disabled states for %j', async options => {
    const { NewSessionPrompt: renderPrompt } = await import('./new-session-prompt');
    const { isCreating, attachmentMax, voiceAvailable, paperclipDisabled } = options;
    voiceInputAvailable.current = voiceAvailable;
    const element = renderPrompt({ ...defaultProps(), isCreating, attachmentMax });

    expect(
      findElementByType(
        element,
        'Pressable',
        ReactI18next.getI18n().t('agentChat.newSession.addAttachment')
      )
    ).toMatchObject({
      disabled: paperclipDisabled,
      accessibilityState: { disabled: paperclipDisabled },
      hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
    });
    expect(findElementByType(element, ComposerPasteButton)).toMatchObject({ disabled: isCreating });
    expect(findElementByType(element, VoiceInputButton)).toEqual(
      voiceAvailable ? expect.objectContaining({ disabled: isCreating, size: 'lg' }) : null
    );
    expect(findElementByType(element, VoiceInputStatus)).toEqual(
      voiceAvailable ? { status: 'idle' } : null
    );
  });

  it('keeps the newline button between the voice status and voice button', async () => {
    const { NewSessionPrompt: renderPrompt } = await import('./new-session-prompt');
    voiceInputAvailable.current = true;
    returnSendsMessage.current = true;
    const element = renderPrompt(defaultProps());
    const controlsProps = findElementByType(element, renderPromptControls);
    expect(controlsProps).not.toBeNull();

    const controls: React.ReactElement<{ children: Node[] }> = renderPromptControls(
      controlsProps as React.ComponentProps<typeof renderPromptControls>
    );
    const [, status, newline, voice] = controls.props.children;

    expect(findElementByType(status, VoiceInputStatus)).not.toBeNull();
    expect(
      findElementByType(
        newline,
        'Pressable',
        ReactI18next.getI18n().t('agentChat.composer.insertNewline')
      )
    ).not.toBeNull();
    expect(findElementByType(voice, VoiceInputButton)).not.toBeNull();
  });

  it('keeps the extracted controls unmounted for clone entry', async () => {
    const { NewSessionPrompt: renderPrompt } = await import('./new-session-prompt');
    voiceInputAvailable.current = true;
    const element = renderPrompt({ ...defaultProps(), isCloneEntry: true });

    expect(findElementByType(element, 'TextInput')).toBeNull();
    expect(findElementByType(element, renderPromptControls)).toBeNull();
  });
});
