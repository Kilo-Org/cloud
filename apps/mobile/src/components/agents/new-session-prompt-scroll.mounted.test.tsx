/* eslint-disable max-lines -- The scroll gate and both clip-edge fade bands share one native-mock harness and the same mount helpers, so a second file would duplicate that harness. */
import { createElement, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';

import {
  NEW_SESSION_PROMPT_DEFAULT_LINES,
  NEW_SESSION_PROMPT_LINE_HEIGHT,
  resolveNewSessionPromptHeight,
} from '@/components/agents/chat-composer-input-height';
import { NewSessionPrompt } from '@/components/agents/new-session-prompt';
import { resolveComposerEdgeFadeHeight } from '@/components/agents/new-session-prompt-fit';

/**
 * The platform the component reads at render. The input's scroll gate is the
 * reported content height on Android and unconditional on iOS, so each case
 * picks the platform before it mounts.
 */
const platform = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));

/**
 * The keyboard's motion progress. The field grows from its keyboard-closed
 * floor to its keyboard-open floor with it, so a case that needs the field
 * closed sets it to zero. The setup's mock is a fixed zero; this suite reads
 * and sets the value.
 */
const keyboardMotion = vi.hoisted(() => ({ value: 0 }));

vi.mock('@/components/keyboard-motion-provider', () => ({
  useKeyboardMotionProgress: () => keyboardMotion,
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

/**
 * The platform reaches the component through `Platform.OS`, and the fade band's
 * top edge is a module-level constant, so a case re-imports the component after
 * the platform flips and re-registers this factory for that import.
 */
function reactNativeMock() {
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    I18nManager: { isRTL: false },
    Platform: platform,
    Pressable: 'Pressable',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    useWindowDimensions: () => ({ fontScale: 1, height: 891, scale: 2.625, width: 411 }),
  };
}

vi.mock('react-native', reactNativeMock);

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  createAnimatedComponent: (component: unknown) => component,
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  useAnimatedStyle: (factory: () => object) => factory(),
  // The field writes the offset during an event and the fade reads it on the
  // render that event causes, so the value has to outlive that render.
  useSharedValue: <T,>(value: T) => useRef({ value }).current,
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

/**
 * Mount the prompt again after the platform flips. The band offsets and the
 * clip edges are module-level constants read at import, so the component must be
 * re-imported for the new platform. The persistent `vi.mock` factory is cached,
 * so `doMock` re-registers it for the fresh import and `resetModules` clears the
 * module cache.
 */
async function mountPromptAfterPlatformChange(overrides: Partial<PromptProps> = {}) {
  vi.doMock('react-native', reactNativeMock);
  vi.resetModules();
  const { NewSessionPrompt: PlatformPrompt } =
    await import('@/components/agents/new-session-prompt');
  const { createElement: createPlatformElement } = await import('react');
  const { act: platformAct, TestRenderer: PlatformRenderer } = await import('@/test/renderer');

  const holder: { current?: ReactTestRenderer } = {};
  await platformAct(async () => {
    await Promise.resolve();
    holder.current = PlatformRenderer.create(
      createPlatformElement(PlatformPrompt, makeProps(overrides))
    );
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('prompt did not mount');
  }
  return { platformAct, renderer };
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

/** The input's `py-2` in dp: NativeWind's native rem is 14, so the utility is 7. */
const PROMPT_INPUT_INSET = 7;
/**
 * A scroll offset where the two platforms' cut lines differ: 10 points into the
 * line under iOS's field top, which is 17 points into the line under Android's
 * text box.
 */
const SCROLLED_OFFSET = PROMPT_INPUT_INSET + 10;

/** A fade band over a cut line: the edge it sits on and how tall it is. */
function findFade(renderer: ReactTestRenderer, edge: 'bottom' | 'top') {
  const node = renderer.root.find(instance => {
    if (typeof instance.type !== 'string' || (instance.type as string) !== 'Animated.View') {
      return false;
    }
    const [frame] = instance.props.style as [{ bottom?: number; top?: number }];
    return frame[edge] !== undefined;
  });
  const [frame, size] = node.props.style as [
    { bottom?: number; top?: number },
    { height?: number },
  ];
  return edge === 'top'
    ? { height: size.height, top: frame.top }
    : { bottom: frame.bottom, height: size.height };
}

/** Report the field's scroll offset the way the native field does. */
function reportScrollOffset(
  renderer: ReactTestRenderer,
  y: number,
  flush: (callback: () => void) => unknown
) {
  const props = findPromptInput(renderer).props as {
    onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
  };
  flush(() => {
    props.onScroll({ nativeEvent: { contentOffset: { y } } });
  });
}

describe('NewSessionPrompt top fade band', () => {
  beforeEach(() => {
    platform.OS = 'ios';
  });

  it('fades from the field top on iOS, where the text view clips at its bounds', async () => {
    const renderer = await mountPrompt();

    reportScrollOffset(renderer, SCROLLED_OFFSET, act);

    // The text view draws scrolled text through its padding and cuts it at its
    // own bounds, so the band starts at the field's top edge, and the offset
    // has to pass the padding before it reaches the cut line.
    expect(findFade(renderer, 'top')).toEqual({
      height: resolveComposerEdgeFadeHeight({
        lineHeight: NEW_SESSION_PROMPT_LINE_HEIGHT,
        scrollOffset: SCROLLED_OFFSET - PROMPT_INPUT_INSET,
      }),
      top: 0,
    });

    renderer.unmount();
  });

  it('fades from the text box on Android, where the edit text clips at its padding', async () => {
    platform.OS = 'android';
    // The band's top edge is a module-level constant, so the component must be
    // re-imported after the platform flips.
    const { platformAct, renderer } = await mountPromptAfterPlatformChange();

    reportScrollOffset(renderer, SCROLLED_OFFSET, platformAct);

    // The edit text cuts its text at the padding, so the band starts at the
    // text box, where the offset already measures the cut.
    expect(findFade(renderer, 'top')).toEqual({
      height: resolveComposerEdgeFadeHeight({
        lineHeight: NEW_SESSION_PROMPT_LINE_HEIGHT,
        scrollOffset: SCROLLED_OFFSET,
      }),
      top: PROMPT_INPUT_INSET,
    });

    renderer.unmount();
  });
});

/**
 * A scroll offset where the bottom cut differs by platform: with the three-line
 * field, iOS's bottom edge lands 19 points into its line and Android's text-box
 * edge lands on the halfway point of its own.
 */
const BOTTOM_SCROLLED_OFFSET = 10;

describe('NewSessionPrompt bottom fade band', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    keyboardMotion.value = 0;
  });

  it('fades the cut bottom line at the field bottom on iOS', async () => {
    const renderer = await mountPrompt();

    reportScrollOffset(renderer, BOTTOM_SCROLLED_OFFSET, act);

    // The text view clips at its own bounds, so the band's bottom is the field's
    // bottom, and the cut edge is the scroll offset plus the field's rendered
    // height, one inset below the first line box's start.
    expect(findFade(renderer, 'bottom')).toEqual({
      bottom: 0,
      height: resolveComposerEdgeFadeHeight({
        lineHeight: NEW_SESSION_PROMPT_LINE_HEIGHT,
        scrollOffset: BOTTOM_SCROLLED_OFFSET + PROMPT_HEIGHT - PROMPT_INPUT_INSET,
      }),
    });

    renderer.unmount();
  });

  it('fades the cut bottom line at the text box on Android', async () => {
    platform.OS = 'android';
    // The bottom inset is a module-level constant, so the component must be
    // re-imported after the platform flips.
    const { platformAct, renderer } = await mountPromptAfterPlatformChange();

    reportScrollOffset(renderer, BOTTOM_SCROLLED_OFFSET, platformAct);

    // The edit text clips at its padding, so the band's bottom is one inset
    // above the field's bottom and the cut edge is one inset higher.
    expect(findFade(renderer, 'bottom')).toEqual({
      bottom: PROMPT_INPUT_INSET,
      height: resolveComposerEdgeFadeHeight({
        lineHeight: NEW_SESSION_PROMPT_LINE_HEIGHT,
        scrollOffset:
          BOTTOM_SCROLLED_OFFSET + PROMPT_HEIGHT - PROMPT_INPUT_INSET - PROMPT_INPUT_INSET,
      }),
    });

    renderer.unmount();
  });
});
