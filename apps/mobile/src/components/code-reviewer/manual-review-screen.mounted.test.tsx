import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { ManualReviewScreen } from './manual-review-screen';

const state = vi.hoisted(() => ({
  github: {
    isLoading: false,
    isError: false,
    isRefetching: false,
    data: { connected: false },
    error: null,
    refetch: vi.fn(),
  },
  gitlab: {
    isLoading: false,
    isError: false,
    isRefetching: false,
    data: { connected: false },
    error: null,
    refetch: vi.fn(),
  },
  push: vi.fn(),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Keyboard: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));
// The screen wraps its form in the shared keyboard-lift view, whose real module
// reads the platform and the safe-area insets (a react-native entry this node
// project cannot load). Sibling mounted specs stub the view for the same
// reason; the reveal hook stays inert with no keyboard padding.
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
  useAppAwareKeyboardPadding: () => 0,
}));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
// The screen reads `useRevealEndOnKeyboard()` on every render, before the
// provider-status branches, and that hook reaches the keyboard-padding module
// (whose safe-area import is not resolvable under this project's Node
// environment). Sibling mounted tests of a screen that reserves keyboard
// height mock the module the same way.
vi.mock('@/components/kilo-chat/use-reveal-end-on-keyboard', () => ({
  useRevealEndOnKeyboard: () => ({ current: null }),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field-a11y', () => ({ formFieldA11y: () => 'a11y' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', GitPullRequest: 'GitPullRequest' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: { github: { label: 'GitHub' }, gitlab: { label: 'GitLab' } },
}));
vi.mock('@/lib/code-reviewer-status', () => ({
  classifyProviderErrorCode: () => ({ permanent: false, variant: 'server' }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({ useAvailableModels: () => ({ models: [] }) }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => state.github,
  useGitLabStatus: () => state.gitlab,
  useReviewConfig: () => ({ data: null }),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useCreateManualReview: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));

function mountScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(ManualReviewScreen, { scope: 'personal' }));
  });
  if (!ref.current) {
    throw new Error('screen did not render');
  }
  return ref.current;
}

beforeEach(() => {
  state.github.data = { connected: false };
  state.gitlab.data = { connected: false };
  state.github.isError = false;
  state.gitlab.isError = false;
  state.push.mockClear();
});

describe('ManualReviewScreen connect provider CTA', () => {
  it('renders the Connect GitHub action full-width like the PR-review connect gate', () => {
    const renderer = mountScreen();

    const empty = renderer.root.findByType('EmptyState');
    const action = empty.props.action as ReactElement<{ className?: string }>;
    const className = String(action.props.className);
    expect(className).toContain('w-full');
    expect(className).toContain('mt-3');

    act(() => {
      renderer.unmount();
    });
  });
});
