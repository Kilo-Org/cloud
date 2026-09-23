import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';

import { NewSessionConfigureForm } from './new-session-configure-form';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
}));

// The composer card is the observation point, not the subject: its props carry
// the frame geometry this suite asserts.
vi.mock('@/components/agents/new-session-prompt', () => ({
  NewSessionPrompt: 'NewSessionPrompt',
}));

vi.mock('@/components/agents/folder-selector', () => ({ LaunchFolderField: 'LaunchFolderField' }));
vi.mock('@/components/agents/new-session-cloud-create-error', () => ({
  NewSessionCloudCreateError: 'NewSessionCloudCreateError',
}));
vi.mock('@/components/agents/new-session-repository-section', () => ({
  NewSessionRepositorySection: 'NewSessionRepositorySection',
}));
vi.mock('@/components/agents/new-session-run-target', () => ({
  NewSessionRunTarget: 'NewSessionRunTarget',
}));
vi.mock('@/components/agents/new-session-start-button', () => ({
  NewSessionStartButton: 'NewSessionStartButton',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ RefreshCw: 'RefreshCw' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type Instance = TestRenderer.ReactTestInstance;
type LayoutHandler = (event: { nativeEvent: { layout: { y: number; height: number } } }) => void;

/** The typed `onLayout` a host carries, so firing it is not an `any` call. */
function layoutHandler(node: Instance | undefined): LayoutHandler | null {
  const handler = node?.props.onLayout as LayoutHandler | undefined;
  return handler ?? null;
}

function defaultProps() {
  return {
    attachments: [] as never[],
    attachmentMax: 5,
    isCreating: false,
    isModelsError: false,
    isLoadingModels: false,
    mode: 'code' as const,
    model: 'anthropic/claude-sonnet-4',
    variant: 'medium',
    modelOptions: [] as never[],
    onChangeText: vi.fn(),
    onModeChange: vi.fn(),
    onModelSelect: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRetryAttachment: vi.fn(),
    onMoveAttachment: vi.fn(),
    onReorderAttachments: vi.fn(),
    onRefetchModels: vi.fn(),
    onPrefillAttachments: vi.fn(),
    shareId: undefined as string | undefined,
    voiceInputSettlerRef: { current: null },
    showRunOnSelector: false,
    runOnInstance: null,
    instanceList: [] as never[],
    isLoadingInstances: false,
    isFetchingInstances: false,
    onRefreshInstances: vi.fn(),
    onChangeRunOnInstance: vi.fn(),
    showInstanceDisconnectedNote: false,
    folderPath: '',
    onChangeFolderPath: vi.fn(),
    groups: [] as never[],
    isRetrying: false,
    onChangeRepo: vi.fn(),
    onConnectProvider: vi.fn(),
    onRefreshRepos: vi.fn(),
    repositories: [] as never[],
    recents: [] as never[],
    selectedRepo: '',
    organizationId: undefined as string | undefined,
    profile: null,
    isProfileLoading: false,
    isProfileError: false,
    onRetryProfile: vi.fn(),
    autoCommit: false,
    onAutoCommitChange: vi.fn(),
    isSpawningRemote: false,
    isStartDisabled: false,
    onStartSession: vi.fn(),
  };
}

function findAllByType(root: Instance, type: string): Instance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

/** The first host below the ScrollView carrying `onLayout` — the composer wrapper. */
function findComposerWrapper(root: Instance): Instance | undefined {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) !== 'ScrollView' &&
      typeof node.props.onLayout === 'function'
  )[0];
}

describe('NewSessionConfigureForm composer frame geometry', () => {
  it('threads the card top gap from the composer wrapper into NewSessionPrompt', async () => {
    const holder: { current?: TestRenderer.ReactTestRenderer } = {};
    await act(() => {
      holder.current = TestRenderer.create(createElement(NewSessionConfigureForm, defaultProps()));
    });
    const renderer = holder.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const scrollView = findAllByType(renderer.root, 'ScrollView')[0];
    const composerWrapper = findComposerWrapper(renderer.root);
    expect(scrollView).toBeDefined();
    expect(composerWrapper).toBeDefined();

    await act(() => {
      // The lifted frame the keyboard leaves.
      layoutHandler(scrollView)?.({ nativeEvent: { layout: { y: 0, height: 380 } } });
      // The content container's `pt-4` inset puts the card 16pt into the frame.
      layoutHandler(composerWrapper)?.({ nativeEvent: { layout: { y: 16, height: 420 } } });
    });

    const prompt = findAllByType(renderer.root, 'NewSessionPrompt')[0];
    expect(prompt).toBeDefined();
    expect(prompt?.props.frameHeight).toBe(380);
    // Regression: the prompt's own onLayout reads 0 against the padding-free
    // wrapper, so the host must pass the wrapper's frame offset instead.
    expect(prompt?.props.cardTop).toBe(16);

    renderer.unmount();
  });
});
