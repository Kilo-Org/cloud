/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable new-cap -- ChatComposer is called as a plain function, matching repo test convention */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake hooks and handlers settle without await because they resolve immediately */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { type ChatComposer } from './chat-composer';

// The attachment-only send contract: a ready (`uploaded`) attachment with an
// empty draft must enable send and deliver `prompt: ''` plus the wire payload.
// Unlike chat-composer.test.ts, this suite uses the real
// `resolveChatComposerControlState` so `canSend` follows text and ready
// attachments, and mocks `useAgentAttachmentUpload` with a controllable return.

const onSendMock = vi.fn(async () => undefined);

// ── React hooks (real useEffect needs rendering context, so mock all hooks) ──
// `useRef` hands out slots in call order and keeps them across calls of the
// same instance, so a test can call the component twice to simulate a
// re-render (`rerender`) with the refs — the composer's live text and its
// applied-draft flag — intact, and start a fresh instance with `mount`.
const refSlots = vi.hoisted(() => ({ slots: [] as { current: unknown }[], cursor: 0 }));

// Controllable upload state. The mock factory reads these at call time, so a
// test mutates them before mounting to drive the ready vs empty cases.
const uploadState = vi.hoisted(() => ({
  attachments: [] as { status?: string; remoteFilename?: string }[],
  toWirePayload: (() => undefined) as () => unknown,
  uploadPending: (() => ({ ok: false })) as () => unknown,
  isUploading: false,
}));

const markAttachmentsSentMock = vi.hoisted(() => vi.fn(async () => undefined));

const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useMemo: vi.fn(<T>(factory: () => T) => factory()),
    useRef: vi.fn(<T>(initial: T) => {
      const index = refSlots.cursor;
      refSlots.cursor += 1;
      refSlots.slots[index] ??= { current: initial };
      return refSlots.slots[index] as React.RefObject<T>;
    }),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
  };
});

// ── react-native and native bridges ────────────────────────────────────────
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  View: 'View',
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

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn(() => ({})) },
  FadeOut: { duration: vi.fn(() => ({})) },
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: toastErrorMock },
}));

// ── sub-components (presentation only; the composer logic is under test) ───
vi.mock('@/components/agents/attachment-preview-strip', () => ({
  AttachmentPreviewStrip: () => null,
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

// NOTE: `resolveChatComposerControlState` is intentionally NOT mocked here so
// `canSend` follows text and ready attachments through the real helper.

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
    attachments: uploadState.attachments,
    addCandidates: vi.fn(async () => undefined),
    removeAttachment: vi.fn(() => undefined),
    retryAttachment: vi.fn(() => undefined),
    reset: vi.fn(() => undefined),
    isUploading: uploadState.isUploading,
    hasFailedAttachments: false,
    toWirePayload: uploadState.toWirePayload,
    toSubmissionPayload: () => undefined,
    uploadPending: uploadState.uploadPending,
  }),
}));

vi.mock('@/lib/agent-attachments/upload-task', () => ({
  markAttachmentsSent: markAttachmentsSentMock,
}));

vi.mock('@/lib/agent-attachments/use-android-pending-picker-recovery', () => ({
  useAndroidPendingPickerRecovery: () => undefined,
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

function requireInputRowOnSubmit(render: React.ReactElement): () => void {
  const rowProps = findInputRowProps(render);
  const onSubmit = rowProps?.onSubmit as (() => void) | undefined;
  if (onSubmit === undefined) {
    throw new Error('ChatComposerInputRow element did not carry an onSubmit handler');
  }
  return onSubmit;
}

async function mount(props: ComposerProps): Promise<React.ReactElement> {
  refSlots.slots.length = 0;
  return rerender(props);
}

async function rerender(props: ComposerProps): Promise<React.ReactElement> {
  refSlots.cursor = 0;
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
  uploadState.attachments = [];
  uploadState.toWirePayload = () => undefined;
  uploadState.uploadPending = () => ({ ok: false });
  uploadState.isUploading = false;
});

describe('ChatComposer attachment-only send', () => {
  it('sends an empty draft with a ready attachment, passing the returned payload and marking sent', async () => {
    uploadState.attachments = [{ status: 'uploaded', remoteFilename: 'file.png' }];
    uploadState.uploadPending = () => ({
      ok: true,
      wire: { path: 'path-1', files: ['file.png'] },
      submission: undefined,
      keys: ['user-1/cloud-agent/path-1/file.png'],
    });

    const render = await mount(makeProps({ draftKey: 'agent-composer:sess-1' }));

    requireInputRowOnSubmit(render)();
    await settle();

    expect(onSendMock).toHaveBeenCalledTimes(1);
    expect(onSendMock).toHaveBeenCalledWith('', { path: 'path-1', files: ['file.png'] }, undefined);
    expect(markAttachmentsSentMock).toHaveBeenCalledTimes(1);
    expect(markAttachmentsSentMock).toHaveBeenCalledWith({
      organizationId: undefined,
      keys: ['user-1/cloud-agent/path-1/file.png'],
    });
  });

  it('does not send an empty draft with no attachments', async () => {
    const render = await mount(makeProps({ draftKey: 'agent-composer:sess-1' }));

    requireInputRowOnSubmit(render)();
    await settle();

    expect(onSendMock).not.toHaveBeenCalled();
    expect(markAttachmentsSentMock).not.toHaveBeenCalled();
  });

  it('toasts when a send is blocked by an in-flight upload', async () => {
    uploadState.attachments = [{ status: 'uploading' }];
    uploadState.isUploading = true;
    uploadState.uploadPending = () => ({ ok: false });

    const render = await mount(makeProps({ draftKey: 'agent-composer:sess-1' }));

    requireInputRowOnSubmit(render)();
    await settle();

    expect(onSendMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith('Wait for attachments to finish uploading.');
  });
});
