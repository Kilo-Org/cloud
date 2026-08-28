/* eslint-disable max-lines -- the mocked hook surface, the draft-restore contract, and the attachment-send mocks require a long suite */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable new-cap -- ChatComposer is called as a plain function, matching repo test convention */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake hooks and handlers settle without await because they resolve immediately */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { Text as renderText } from '@/components/ui/text';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import { type ChatComposer } from './chat-composer';

const layoutDirection = vi.hoisted(() => ({ isRTL: false }));
const TEXT_DIRECTIONS = [
  { direction: 'LTR', isRTL: false, style: undefined },
  { direction: 'RTL', isRTL: true, style: [{ writingDirection: 'rtl' }, undefined] },
];

vi.mock('@rn-primitives/slot', () => ({ Text: 'SlotText' }));

// The composer's uncontrolled input is covered by Appium E2E; this suite pins
// the draft-restore contract that a native E2E cannot easily prove: a restored
// draft must be readable by an immediate send (before any keystroke). The
// component is invoked as a plain function with mocked hooks so the restore
// effect runs synchronously, and the submit path is driven through the
// onSubmit handler found on the ChatComposerInputRow element in the tree.

const onSendMock = vi.fn(async () => undefined);

// ── React hooks (real useEffect needs rendering context, so mock all hooks) ──
// `useRef` hands out slots in call order and keeps them across calls of the
// same instance, so a test can call the component twice to simulate a
// re-render (`rerender`) with the refs — the composer's live text and its
// applied-draft flag — intact, and start a fresh instance with `mount`.
const refSlots = vi.hoisted(() => ({ slots: [] as { current: unknown }[], cursor: 0 }));
// `useState` is stateful per call-order slot (mirroring `refSlots`) so the
// starter/`hasText` gating can be observed across a re-render, not just the
// mount-time initial value.
const stateSlots = vi.hoisted(() => ({ slots: [] as { value: unknown }[], cursor: 0 }));
const returnSendsPref = vi.hoisted(() => ({ returnSendsMessage: false }));
const reducedMotionOn = vi.hoisted(() => ({ value: false }));

// The strip wire-lock test asserts the composer forwards the upload hook's
// move/reorder callbacks by identity, so both mocks must be hoisted and shared.
const uploadMoveAttachmentMock = vi.hoisted(() => vi.fn());
const uploadReorderAttachmentsMock = vi.hoisted(() => vi.fn());

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useContext: vi.fn(() => undefined),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useImperativeHandle: vi.fn(() => undefined),
    useMemo: vi.fn(<T>(factory: () => T) => factory()),
    useRef: vi.fn(<T>(initial: T) => {
      const index = refSlots.cursor;
      refSlots.cursor += 1;
      refSlots.slots[index] ??= { current: initial };
      return refSlots.slots[index] as React.RefObject<T>;
    }),
    useState: vi.fn(<T>(initial: T) => {
      const index = stateSlots.cursor;
      stateSlots.cursor += 1;
      const slot = (stateSlots.slots[index] ??= { value: initial as unknown });
      return [
        slot.value as T,
        (next: T | ((prev: T) => T)) => {
          slot.value =
            typeof next === 'function' ? (next as (prev: T) => T)(slot.value as T) : next;
        },
      ] as [T, (value: T | ((prev: T) => T)) => void];
    }),
  };
});

// ── react-native and native bridges ────────────────────────────────────────
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Keyboard: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    dismiss: vi.fn(),
  },
  I18nManager: layoutDirection,
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  useWindowDimensions: () => ({ fontScale: 1, height: 800, scale: 1, width: 400 }),
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => ({
      runOnJS: () => ({
        activeOffsetY: () => ({
          failOffsetX: () => ({
            enabled: () => ({
              onStart: () => ({}),
            }),
          }),
        }),
      }),
    }),
  },
  GestureDetector: () => null,
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ dispatch: vi.fn() }),
}));

vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: vi.fn(),
}));

vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: () => null,
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn(() => ({})) },
  FadeOut: { duration: vi.fn(() => ({})) },
  useReducedMotion: () => reducedMotionOn.value,
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

// ── sub-components (presentation only; the composer logic is under test) ───
const MockAttachmentPreviewStrip = () => null;

vi.mock('@/components/agents/attachment-preview-strip', () => ({
  AttachmentPreviewStrip: MockAttachmentPreviewStrip,
}));

vi.mock('@/components/agents/attachment-paste-hint', () => ({
  AttachmentPasteHint: () => null,
}));

vi.mock('@/components/agents/chat-toolbar', () => ({
  ChatToolbar: () => null,
}));

vi.mock('@/components/agents/slash-command-suggestions', () => ({
  SlashCommandSuggestions: () => null,
}));

// Marked so the test can locate the input-row element in the returned tree
// (plain function calls build element objects; child components are not
// invoked without a renderer).
const MockInputRow = () => null;
(MockInputRow as { __testMarker?: boolean }).__testMarker = true;

vi.mock('@/components/agents/chat-composer-input-row', () => ({
  ChatComposerInputRow: MockInputRow,
}));

vi.mock('@/components/agents/attachment-picker', () => ({
  pickAgentAttachments: vi.fn(),
}));

vi.mock('@/components/agents/remote-session-exit-alert', () => ({
  showRemoteSessionExitConfirmation: vi.fn(),
}));

vi.mock('@/components/agents/use-text-height', () => ({
  useTextHeight: () => ({
    height: 88,
    measureElement: null,
    reset: vi.fn(),
    setText: vi.fn(),
  }),
}));

vi.mock('@/components/agents/chat-composer-input-state', () => ({
  // The real gate (hasText → canSend) is covered by chat-composer-input-state
  // tests; this suite isolates the restore → send path. `canSend` follows the
  // live draft (textRef, the first useRef slot) so an empty draft stays
  // non-sendable now that handleSend no longer guards on `!trimmed`.
  resolveChatComposerControlState: () => {
    const draft = (refSlots.slots[0]?.current as string | undefined) ?? '';
    return {
      canSend: draft.trim().length > 0,
      inputAccessibilityDisabled: false,
      inputEditable: true,
      paperclipDisabled: false,
      showToolbar: true,
      toolbarDisabled: false,
      voiceDisabled: false,
    };
  },
}));

vi.mock('@/components/ui/blur-bar', () => ({
  BlurBar: () => null,
}));

vi.mock('@/components/voice-input-control', () => ({
  VoiceInputStatus: () => null,
}));

// ── hooks and libs ─────────────────────────────────────────────────────────
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1' }),
}));

vi.mock('@/lib/agent-attachments/use-agent-attachment-upload', () => ({
  useAgentAttachmentUpload: () => ({
    attachments: [],
    addCandidates: vi.fn(async () => undefined),
    removeAttachment: vi.fn(() => undefined),
    retryAttachment: vi.fn(() => undefined),
    moveAttachment: uploadMoveAttachmentMock,
    reorderAttachments: uploadReorderAttachmentsMock,
    reset: vi.fn(() => undefined),
    commitSent: vi.fn(() => undefined),
    isUploading: false,
    hasFailedAttachments: false,
    uploadPending: vi.fn(async () => ({
      ok: true,
      wire: undefined,
      submission: undefined,
    })),
  }),
}));

vi.mock('@/lib/agent-attachments/use-clipboard-image-hint', () => ({
  useClipboardImageHint: () => ({
    visible: false,
    refresh: vi.fn(),
    paste: vi.fn(),
  }),
}));

vi.mock('@/lib/agent-attachments/use-clipboard-paste', () => ({
  useClipboardPaste: () => ({
    visible: false,
    refresh: vi.fn(),
    paste: vi.fn(),
  }),
}));

vi.mock('@/lib/agent-attachments/validate', () => ({
  describeClassificationFailure: vi.fn(),
}));

vi.mock('@/lib/agent-attachments/use-android-pending-picker-recovery', () => ({
  useAndroidPendingPickerRecovery: () => undefined,
}));

vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  flushDraft: vi.fn(async () => undefined),
  clearDraft: vi.fn(async () => undefined),
}));

vi.mock('@/lib/share-prefill', () => ({
  useSharePrefill: vi.fn(),
}));

vi.mock('@/lib/voice-input/use-voice-input', () => ({
  useVoiceInput: () => ({
    available: false,
    isActive: false,
    settleBeforeSubmit: vi.fn(async () => true),
    status: 'idle',
    toggle: vi.fn(),
  }),
}));

vi.mock('@/lib/voice-input/voice-input-draft', () => ({
  applyVoiceDraftToInput: vi.fn(),
}));

vi.mock('@/lib/hooks/use-return-sends-message-preference', () => ({
  useReturnSendsMessagePreference: () => ({
    returnSendsMessage: returnSendsPref.returnSendsMessage,
    hasLoaded: true,
    setReturnSendsMessage: vi.fn(),
  }),
}));

type ComposerProps = Parameters<typeof ChatComposer>[0];

function makeProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    onSend: onSendMock,
    onSendCommand: vi.fn(async () => true),
    onCreateSession: vi.fn(async () => true),
    onRestartSession: vi.fn(async () => true),
    onExitSession: vi.fn(async () => undefined),
    onStop: vi.fn(async () => undefined),
    mode: 'code' as AgentMode,
    onModeChange: vi.fn(() => undefined),
    model: 'anthropic/claude-sonnet-4',
    variant: 'medium',
    modelOptions: [],
    onModelSelect: vi.fn(() => undefined),
    ...overrides,
  };
}

type Node = { props?: unknown } | null | undefined | string | number | boolean;

function findInputRowProps(node: Node): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const type = (node as { type?: unknown }).type;
  if (typeof type === 'function' && (type as { __testMarker?: boolean }).__testMarker === true) {
    return (node as { props?: Record<string, unknown> }).props ?? {};
  }
  const children = (node as { props?: { children?: unknown } }).props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findInputRowProps(child as Node);
    if (found) {
      return found;
    }
  }
  return null;
}

function findStripProps(node: Node): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const type = (node as { type?: unknown }).type;
  if (type === MockAttachmentPreviewStrip) {
    return (node as { props?: Record<string, unknown> }).props ?? {};
  }
  const children = (node as { props?: { children?: unknown } }).props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findStripProps(child as Node);
    if (found) {
      return found;
    }
  }
  return null;
}

function requireInputRowOnSubmit(render: React.ReactElement): () => void {
  const rowProps = findInputRowProps(render);
  const onSubmit = rowProps?.onSubmit as (() => void) | undefined;
  if (onSubmit === undefined) {
    throw new Error('ChatComposerInputRow element did not carry an onSubmit handler');
  }
  return onSubmit;
}

function requireInputRowOnChangeText(render: React.ReactElement): (text: string) => void {
  const rowProps = findInputRowProps(render);
  const onChangeText = rowProps?.onChangeText as ((text: string) => void) | undefined;
  if (onChangeText === undefined) {
    throw new Error('ChatComposerInputRow element did not carry an onChangeText handler');
  }
  return onChangeText;
}

function findNode(
  node: Node,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean
): { type: unknown; props: Record<string, unknown> } | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const { type, props } = node as { type?: unknown; props?: Record<string, unknown> };
  if (props !== undefined && predicate(type, props)) {
    return { type, props };
  }
  if (type === renderText && props !== undefined) {
    return findNode(renderText(props as React.ComponentProps<typeof renderText>), predicate);
  }
  const children = props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findNode(child as Node, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function findStarterChip(render: React.ReactElement, label: string) {
  return findNode(
    render,
    (type, props) => type === 'Pressable' && props.accessibilityLabel === label
  );
}

async function mount(props: ComposerProps): Promise<React.ReactElement> {
  refSlots.slots.length = 0;
  stateSlots.slots.length = 0;
  return rerender(props);
}

async function rerender(props: ComposerProps): Promise<React.ReactElement> {
  refSlots.cursor = 0;
  stateSlots.cursor = 0;
  const { ChatComposer } = await import('./chat-composer');
  return ChatComposer(props);
}

async function settle(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  refSlots.slots.length = 0;
  refSlots.cursor = 0;
  stateSlots.slots.length = 0;
  stateSlots.cursor = 0;
  returnSendsPref.returnSendsMessage = false;
  reducedMotionOn.value = false;
  layoutDirection.isRTL = false;
});

// The restore contract has one axis: whether the host resolved a draft. Both
// cases run the identical mount → submit sequence, so one table drives them.
const RESTORE_CASES = [
  {
    name: 'sends the restored draft immediately on submit, before any keystroke',
    initialDraft: 'Restored draft text',
    sent: 'Restored draft text',
  },
  {
    name: 'does not send when there is no restored draft',
    initialDraft: undefined,
    sent: null,
  },
] as const;

describe('ChatComposer draft restore', () => {
  it.each(RESTORE_CASES)('$name', async ({ initialDraft, sent }) => {
    const render = await mount(
      makeProps({
        draftKey: 'agent-composer:sess-1',
        initialDraft,
      })
    );

    // The restore effect runs synchronously under the mocked hooks; submit
    // must read the restored text from the live ref, not the mount-time ''.
    requireInputRowOnSubmit(render)();
    await settle();

    if (sent === null) {
      expect(onSendMock).not.toHaveBeenCalled();
      return;
    }
    expect(onSendMock).toHaveBeenCalledTimes(1);
    expect(onSendMock).toHaveBeenCalledWith(sent, {
      attachments: undefined,
      submission: undefined,
      onOptimisticSend: expect.any(Function),
    });
  });

  // The host mounts the composer before identity (`user.getMe`) and the draft
  // load settle, so `initialDraft` is undefined on the first render and arrives
  // later. Both cases below start from that first render.
  it('is usable before the draft settles and applies a draft that arrives after mount', async () => {
    await mount(makeProps({ draftKey: 'agent-composer:sess-1', initialDraft: undefined }));

    const settled = await rerender(
      makeProps({ draftKey: 'agent-composer:sess-1', initialDraft: 'Restored draft text' })
    );
    requireInputRowOnSubmit(settled)();
    await settle();

    expect(onSendMock).toHaveBeenCalledWith('Restored draft text', {
      attachments: undefined,
      submission: undefined,
      onOptimisticSend: expect.any(Function),
    });
  });

  it('keeps text typed before the draft settles instead of restoring over it', async () => {
    const pending = await mount(
      makeProps({ draftKey: 'agent-composer:sess-1', initialDraft: undefined })
    );
    requireInputRowOnChangeText(pending)('typed while identity was loading');

    const settled = await rerender(
      makeProps({ draftKey: 'agent-composer:sess-1', initialDraft: 'Restored draft text' })
    );
    requireInputRowOnSubmit(settled)();
    await settle();

    expect(onSendMock).toHaveBeenCalledWith('typed while identity was loading', {
      attachments: undefined,
      submission: undefined,
      onOptimisticSend: expect.any(Function),
    });
  });
});
describe('ChatComposer return-sends wiring', () => {
  it('wires the return-sends preference and an insert-newline handler to the input row', async () => {
    returnSendsPref.returnSendsMessage = true;
    const withReturnSend = findInputRowProps(await mount(makeProps({})));
    expect(withReturnSend?.returnSendsMessage).toBe(true);
    expect(typeof withReturnSend?.onInsertNewline).toBe('function');

    returnSendsPref.returnSendsMessage = false;
    const withNewline = findInputRowProps(await mount(makeProps({})));
    expect(withNewline?.returnSendsMessage).toBe(false);
  });

  it('inserts a newline into the draft without submitting', async () => {
    returnSendsPref.returnSendsMessage = true;
    const render = await mount(makeProps({}));
    const rowProps = findInputRowProps(render);
    const onInsertNewline = rowProps?.onInsertNewline as (() => void) | undefined;
    if (onInsertNewline === undefined) {
      throw new Error('ChatComposerInputRow element did not carry an onInsertNewline handler');
    }

    onInsertNewline();

    expect(refSlots.slots[0]?.current).toBe('\n');
    expect(onSendMock).not.toHaveBeenCalled();
  });
});

describe('ChatComposer starter chips', () => {
  it('hides starters once the input holds text', async () => {
    const render = await mount(makeProps({}));
    expect(findStarterChip(render, 'Build a feature')).not.toBeNull();

    requireInputRowOnChangeText(render)('typed text');
    await settle();

    const rerendered = await rerender(makeProps({}));
    expect(findStarterChip(rerendered, 'Build a feature')).toBeNull();
  });

  it.each(TEXT_DIRECTIONS)(
    'preserves starter text and inserts it without submitting in $direction',
    async ({ isRTL, style }) => {
      layoutDirection.isRTL = isRTL;
      const render = await mount(makeProps({}));
      const chip = findStarterChip(render, 'Build a feature');
      if (!chip) {
        throw new Error('starter chip not found');
      }
      expect(findNode(chip, type => type === 'Text')?.props).toMatchObject({
        children: 'Build a feature',
        className: 'text-sm font-normal text-muted-foreground',
        style,
      });
      const onPress = chip.props.onPress as (() => void) | undefined;
      if (!onPress) {
        throw new Error('starter chip missing onPress');
      }

      onPress();
      await settle();

      expect(refSlots.slots[0]?.current).toBe('Build a feature');
      expect(onSendMock).not.toHaveBeenCalled();
    }
  );
});

describe('ChatComposer counter', () => {
  it.each(TEXT_DIRECTIONS)(
    'shows the remaining-character counter only once the draft nears the limit in $direction',
    async ({ isRTL, style }) => {
      layoutDirection.isRTL = isRTL;
      const render = await mount(makeProps({}));
      expect(
        findNode(render, (type, props) => type === 'Text' && typeof props.children === 'number')
      ).toBeNull();

      requireInputRowOnChangeText(render)('hello');
      await settle();
      expect(
        findNode(
          await rerender(makeProps({})),
          (type, props) => type === 'Text' && typeof props.children === 'number'
        )
      ).toBeNull();

      requireInputRowOnChangeText(render)('x'.repeat(CLOUD_AGENT_PROMPT_MAX_LENGTH - 5));
      await settle();

      const rerendered = await rerender(makeProps({}));
      const counter = findNode(
        rerendered,
        (type, props) => type === 'Text' && props.children === 5
      );
      expect(counter).not.toBeNull();
      expect(counter?.props).toMatchObject({
        accessibilityLabel: '5 characters remaining',
        className: 'text-xs font-normal text-muted-foreground',
        style,
      });
    }
  );
});

describe('ChatComposer reduced motion', () => {
  it('drops the toolbar entrance animation under reduced motion', async () => {
    reducedMotionOn.value = true;
    const render = await mount(makeProps({}));

    const toolbarView = findNode(render, type => type === 'Animated.View');
    expect(toolbarView).not.toBeNull();
    expect(toolbarView?.props.entering).toBeUndefined();
  });
});

describe('ChatComposer attachment strip wiring', () => {
  it('wires onMove and onReorder from the upload hook into the attachment strip', async () => {
    const render = await mount(makeProps({}));

    const stripProps = findStripProps(render);
    if (stripProps === null) {
      throw new Error('AttachmentPreviewStrip element not found');
    }
    expect(stripProps.onMove).toBe(uploadMoveAttachmentMock);
    expect(stripProps.onReorder).toBe(uploadReorderAttachmentsMock);
  });
});
