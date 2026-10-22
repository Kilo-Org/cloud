import { type ComponentProps, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';

import { NewSessionConfigureForm } from './new-session-configure-form';

// The card's input is uncontrolled, so this suite mounts the form for real: what
// it asserts is what a rotation leaves in the field, which a tree walk over a
// single render cannot show.
const windowState = vi.hoisted(() => ({ width: 411, height: 914 }));

vi.mock('react-native', () => ({
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useColorScheme: () => 'light',
  useWindowDimensions: () => windowState,
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The real policy reaches `expo-battery` -> `expo-modules-core`, whose entry
// reads the `__DEV__` global this node-mounted harness does not define.
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

// Every section below the card is irrelevant here; the card itself is a host so
// its props (the seed and the change reporter) can be read and driven.
vi.mock('./new-session-prompt', () => ({ NewSessionPrompt: 'NewSessionPrompt' }));
vi.mock('./new-session-repository-section', () => ({
  NewSessionRepositorySection: 'NewSessionRepositorySection',
}));
vi.mock('./new-session-run-target', () => ({ NewSessionRunTarget: 'NewSessionRunTarget' }));
vi.mock('./folder-selector', () => ({ LaunchFolderField: 'LaunchFolderField' }));
vi.mock('./new-session-start-button', () => ({ NewSessionStartButton: 'NewSessionStartButton' }));
vi.mock('./new-session-cloud-create-error', () => ({
  NewSessionCloudCreateError: 'NewSessionCloudCreateError',
}));
vi.mock('./advanced-config-panel', () => ({ AdvancedConfigPanel: 'AdvancedConfigPanel' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

type Instance = TestRenderer.ReactTestInstance;

const SEED = 'seeded draft';

function props() {
  return {
    attachments: [] as never[],
    attachmentMax: 5,
    isCreating: false,
    isModelsError: false,
    isLoadingModels: false,
    mode: 'code' as never,
    model: 'kilo-auto/efficient',
    variant: '',
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
    initialPrompt: SEED,
    showRunOnSelector: false,
    runOnInstance: null as never,
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
    profileOverrideNeedsAttention: false,
    onRetryProfile: vi.fn(),
    onOpenProfilePicker: vi.fn(),
    selectedProfileId: null,
    onSelectProfile: vi.fn(),
    manualVars: [],
    manualCommands: [],
    onManualVarsChange: vi.fn(),
    onManualCommandsChange: vi.fn(),
    autoCommit: false,
    onAutoCommitChange: vi.fn(),
    isSpawningRemote: false,
    isStartDisabled: false,
    onStartSession: vi.fn(),
  };
}

function promptHost(renderer: TestRenderer.ReactTestRenderer): Instance {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.type === 'string' && (candidate.type as string) === 'NewSessionPrompt'
  );
  if (!node) {
    throw new Error('the form rendered no composer card');
  }
  return node;
}

function scrollCount(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(
    candidate => typeof candidate.type === 'string' && (candidate.type as string) === 'ScrollView'
  ).length;
}

async function mount(
  shared: ComponentProps<typeof NewSessionConfigureForm>
): Promise<TestRenderer.ReactTestRenderer> {
  windowState.width = 411;
  windowState.height = 914;
  const renderer = await act(() =>
    TestRenderer.create(createElement(NewSessionConfigureForm, shared))
  );
  return renderer;
}

describe('NewSessionConfigureForm across a layout switch', () => {
  it('seeds the remounted card with the live draft, not the entry prefill', async () => {
    const shared = props();
    const renderer = await mount(shared);
    expect(promptHost(renderer).props.initialPrompt).toBe(SEED);
    expect(scrollCount(renderer)).toBe(1);

    // The user types in the portrait column; the card reports the draft upward.
    await act(() => {
      (promptHost(renderer).props.onChangeText as (text: string) => void)(
        'draft typed on the phone'
      );
    });
    expect(shared.onChangeText).toHaveBeenCalledWith('draft typed on the phone');

    // Rotating splits the form, which moves the card into its own column and
    // remounts the uncontrolled input.
    windowState.width = 914;
    windowState.height = 411;
    await act(() => {
      renderer.update(createElement(NewSessionConfigureForm, shared));
    });

    expect(scrollCount(renderer)).toBe(2);
    expect(promptHost(renderer).props.initialPrompt).toBe('draft typed on the phone');

    renderer.unmount();
  });
});
