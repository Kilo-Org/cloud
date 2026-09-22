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
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
// The screen reads `useRevealEndOnKeyboard()` on every render, before the
// provider-status branches, and that hook reaches the keyboard-padding module
// (whose safe-area import is not resolvable under this project's Node
// environment). The keyboard-lift view reads the device insets through
// `react-native-safe-area-context`, whose CommonJS entry requires a Flow
// react-native subpath this node project cannot load, so stub both kilo-chat
// modules the way the sibling node-only screen tests do.
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  AppAwareKeyboardPaddingView: 'AppAwareKeyboardPaddingView',
  useAppAwareKeyboardPadding: () => 0,
}));
vi.mock('@/components/kilo-chat/use-reveal-end-on-keyboard', () => ({
  useRevealEndOnKeyboard: () => ({ current: null }),
}));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
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
