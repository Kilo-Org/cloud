/* eslint-disable max-lines -- the mocked native surface needs one mock block per bridge */
/* eslint-disable require-await, @typescript-eslint/require-await -- mock factories settle without await, matching chat-composer-send-once.mounted.test.tsx */
import * as React from 'react';
import { createElement, Profiler } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './chat-composer';
import { COMPOSER_INPUT_MAX_HEIGHT } from './chat-composer-input-height';

// Pins the composer's typing-render contract: typing a keystroke must not
// re-render the 1400-line `ChatComposer`. The hidden mirror and its measurement
// live in the `ChatComposerMeasure` leaf, so a typed frame commits the composer
// only when a rendered derived value changes (the hasText flip, a slash
// candidate, the measured height, or the counter). This suite types the owner's
// 8-line / 288-character growth draft one keystroke per frame — the draft from
// the Android evidence — and counts the composer's commits.
//
// The Profiler sits on a direct child that re-renders exactly when the composer
// renders (`AttachmentPreviewStrip`). A Profiler around the composer itself
// would count the leaf's own per-keystroke commits too — React fires onRender
// for any commit in the profiled subtree — so it would not isolate the
// composer. Wrapping the child whose element identity the composer recreates
// each render measures the composer's own commits.

const composerCommits = vi.hoisted(() => ({ count: 0 }));

// ── native bridges ───────────────────────────────────────────────────────────
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
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    dismiss: vi.fn(),
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

// The commit probe: this child re-renders exactly when the composer renders,
// and its Profiler reports those commits.
vi.mock('@/components/agents/attachment-preview-strip', () => ({
  AttachmentPreviewStrip: () =>
    createElement(
      Profiler,
      {
        id: 'chat-composer-commits',
        onRender: () => {
          composerCommits.count += 1;
        },
      },
      null
    ),
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
    attachmentsEnabled: true,
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

async function tick(ms = 0): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** The owner's growth draft: 8 lines, 288 characters. */
const DRAFT = `${'x'.repeat(35)}\n`.repeat(7) + 'x'.repeat(36);

function lineCountOf(text: string): number {
  return (text.match(/\n/g)?.length ?? 0) + 1;
}

function findTextInput(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => typeof node.type === 'string' && (node.type as string) === 'TextInput');
}

function findMirror(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      typeof node.props.onLayout === 'function'
  );
}

describe('ChatComposer typing render cost', () => {
  beforeEach(() => {
    composerCommits.count = 0;
  });

  it('commits only on rendered derived values while an 8-line draft grows one keystroke per frame', async () => {
    const holder: { current?: TestRenderer.ReactTestRenderer } = {};
    await act(async () => {
      holder.current = TestRenderer.create(createElement(ChatComposer, baseProps()));
    });
    const renderer = holder.current;
    if (renderer === undefined) {
      throw new Error('renderer was not created');
    }

    // The input reports its width, so the hidden mirror (`useTextHeight`)
    // renders and can be laid out below.
    const inputWrapper = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        typeof node.props.onLayout === 'function'
    );
    await act(async () => {
      (inputWrapper.props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { height: 48, width: 234 } },
      });
      await tick();
    });

    const input = findTextInput(renderer.root);
    const mirror = findMirror(renderer.root);

    // Baseline after mount and the input layout; count only the typed frames.
    composerCommits.count = 0;
    const mountHeight = (input.props.style as { height: number }).height;
    const inputHeights: number[] = [];
    let heightChanges = 0;
    let lastLineCount = 1;
    for (let index = 1; index <= DRAFT.length; index += 1) {
      const draft = DRAFT.slice(0, index);
      // eslint-disable-next-line no-await-in-loop -- one typed frame per keystroke is the behavior under test
      await act(async () => {
        (input.props.onChangeText as (value: string) => void)(draft);
        // One macrotask publishes the coalesced text into the measure leaf and
        // the derived state that changed.
        await tick();
      });
      const lineCount = lineCountOf(draft);
      if (lineCount !== lastLineCount) {
        lastLineCount = lineCount;
        heightChanges += 1;
        // The mirror re-laid-out for the new line: report its rendered height,
        // as the platform's `onLayout` does. 24pt padding + 20pt per line.
        // eslint-disable-next-line no-await-in-loop -- one layout per added line mirrors the device
        await act(async () => {
          (mirror.props.onLayout as (event: unknown) => void)({
            nativeEvent: { layout: { height: lineCount * 20, width: 200 } },
          });
          await tick();
        });
        inputHeights.push((input.props.style as { height: number }).height);
      }
    }

    // The leaf received every keystroke (the hidden mirror holds the full
    // draft) even though the composer itself did not commit per frame.
    expect(DRAFT).toHaveLength(288);
    expect(lineCountOf(DRAFT)).toBe(8);
    expect(mirror.children).toEqual([DRAFT]);

    // The composer must not have committed once per typed frame. A typed frame
    // that changed no rendered value (most of the 288) commits nothing; only
    // the hasText flip and each line whose measured height changed do. For
    // contrast, the pre-change composer held the raw character count and the
    // measure node on its own render path, so it committed once per keystroke.
    expect(composerCommits.count).toBeLessThanOrEqual(heightChanges + 2);
    expect(composerCommits.count).toBeLessThan(DRAFT.length / 10);
    expect(heightChanges).toBeGreaterThan(0);
    // Positive control for the two upper bounds above: both stay satisfied by a
    // count of 0, so without this they could pass vacuously if the probe's mock
    // stopped firing (a mock or renderer change). A composer that published the
    // hasText flip and the grown height must have counted at least one commit.
    expect(composerCommits.count).toBeGreaterThan(0);

    // The commit bound alone is one-sided: a composer that never republished
    // the measurement would commit less, not more. Pin the other half of the
    // owner's growth contract — the input must still grow line by line and hold
    // at the cap, with the row scrollable once capped. This suite never reports
    // the real input's `onContentSizeChange`, so `nativeContentHeight` stays
    // null, `useTextHeight` derives no native pitch, and the cap exercised here
    // is the raw remaining-space cap (`COMPOSER_INPUT_MAX_HEIGHT`); the line
    // snapping that only runs once a native pitch is known is not covered.
    // Each entry is one added line's published height: the 24pt vertical
    // padding plus 20pt per line from the second line on, clamped to the cap.
    expect(inputHeights).toEqual(
      [2, 3, 4, 5, 6, 7, 8].map(lines => Math.min(lines * 20 + 24, COMPOSER_INPUT_MAX_HEIGHT))
    );
    const firstHeight = inputHeights.at(0) ?? Number.NaN;
    const lastHeight = inputHeights.at(-1) ?? Number.NaN;
    const previousHeight = inputHeights.at(-2) ?? Number.NaN;
    expect(firstHeight).toBeGreaterThan(mountHeight);
    expect(
      inputHeights.every(
        (height, index) =>
          index === 0 || height >= (inputHeights.at(index - 1) ?? Number.POSITIVE_INFINITY)
      )
    ).toBe(true);
    expect(lastHeight).toBe(previousHeight);
    expect(input.props.scrollEnabled).toBe(true);

    renderer.unmount();
  });
});
