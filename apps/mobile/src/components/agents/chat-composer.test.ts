/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable new-cap -- ChatComposer is called as a plain function, matching repo test convention */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake hooks and handlers settle without await because they resolve immediately */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { type ChatComposer } from './chat-composer';

// The composer's uncontrolled input is covered by Appium E2E; this suite pins
// the draft-restore contract that a native E2E cannot easily prove: a restored
// draft must be readable by an immediate send (before any keystroke). The
// component is invoked as a plain function with mocked hooks so the restore
// effect runs synchronously, and the submit path is driven through the
// onSubmit handler found on the ChatComposerInputRow element in the tree.

const onSendMock = vi.fn(async () => undefined);

// ── React hooks (real useEffect needs rendering context, so mock all hooks) ──
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
      const ref: React.RefObject<T> = { current: initial };
      return ref;
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
  toast: { error: vi.fn() },
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

vi.mock('@/components/agents/chat-composer-input-state', () => ({
  // The real gate (hasText → canSend) is covered by chat-composer-input-state
  // tests; this suite isolates the restore → send path.
  resolveChatComposerControlState: () => ({
    canSend: true,
    inputAccessibilityDisabled: false,
    inputEditable: true,
    paperclipDisabled: false,
    showToolbar: true,
    toolbarDisabled: false,
    voiceDisabled: false,
  }),
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
    reset: vi.fn(() => undefined),
    isUploading: false,
    hasFailedAttachments: false,
    toWirePayload: () => undefined,
    toSubmissionPayload: () => undefined,
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChatComposer draft restore', () => {
  it('sends the restored draft immediately on submit, before any keystroke', async () => {
    const { ChatComposer } = await import('./chat-composer');

    const render = ChatComposer(
      makeProps({
        draftKey: 'agent-composer:sess-1',
        initialDraft: 'Restored draft text',
      })
    );

    // The restore effect runs synchronously under the mocked hooks; submit
    // must read the restored text from the live ref, not the mount-time ''.
    requireInputRowOnSubmit(render)();
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    expect(onSendMock).toHaveBeenCalledTimes(1);
    expect(onSendMock).toHaveBeenCalledWith('Restored draft text', undefined, undefined);
  });

  it('does not send when there is no restored draft', async () => {
    const { ChatComposer } = await import('./chat-composer');

    const render = ChatComposer(
      makeProps({
        draftKey: 'agent-composer:sess-1',
        initialDraft: undefined,
      })
    );

    requireInputRowOnSubmit(render)();
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    expect(onSendMock).not.toHaveBeenCalled();
  });
});
