import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { TabBarLabelContext } from '@/lib/tab-bar-clearance';

import { ManualReviewScreen } from './manual-review-screen';

// A failed start used to render the server's English message inside an
// otherwise localized screen. These tests settle the mutation the way the tRPC
// client does and assert the inline copy comes from the error code.

const GITHUB_PR_URL = 'https://github.com/acme/widgets/pull/1';
// The connected path's NOT_FOUND text: same code, a different sentence from
// the copy the screen renders, so a passing assertion proves code-based mapping.
const SERVER_NOT_FOUND = 'No connected GitHub installation can read this pull request.';

type StartMutationOptions = {
  onSuccess?: (result: { reviewId: string }) => void;
  onError?: (error: unknown) => void;
};

const platformState = vi.hoisted(() => ({ OS: 'android' }));
const status = vi.hoisted(() => ({ connected: true, pending: false, push: vi.fn() }));
const startMutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  lastOptions: null as StartMutationOptions | null,
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(), setAccessibilityFocus: vi.fn() },
  Platform: {
    get OS() {
      return platformState.OS;
    },
  },
  Dimensions: { get: () => ({ height: 900 }) },
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: 'KeyboardProvider',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  KeyboardChatScrollView: 'KeyboardChatScrollView',
  useKeyboardState: () => ({ height: 0, isVisible: false, progress: 0, duration: 0 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn(), push: status.push }) }));
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
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: { github: { label: 'GitHub' }, gitlab: { label: 'GitLab' } },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#ffffff',
    mutedForeground: '#888888',
    primary: '#e5e54b',
    primaryForeground: '#111111',
  }),
}));
vi.mock('@/lib/hooks/use-reviewer-models', () => ({ useReviewerModels: () => ({ models: [] }) }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({
    data: { connected: status.connected },
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useGitLabStatus: () => ({
    data: { connected: false },
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useReviewConfig: () => ({ data: { modelSlug: 'model-x', thinkingEffort: null } }),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useCreateManualReview: () => ({
    mutate: (vars: unknown, options: StartMutationOptions) => {
      startMutation.lastOptions = options;
      startMutation.mutate(vars);
    },
    isPending: status.pending,
  }),
}));

function findAllOfType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => String(node.type) === type);
}

async function renderScreen() {
  const { renderer, unmount } = await renderWithProviders(
    createElement(
      TabBarLabelContext,
      { value: null },
      createElement(ManualReviewScreen, { scope: 'personal' })
    )
  );
  return { renderer, unmount };
}

/** A failed call as the tRPC client reports it: a code plus the server's message. */
function trpcError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

/** Every string rendered through the shared `Text` mock. */
function renderedTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return findAllOfType(renderer.root, 'Text').flatMap(node => {
    const { children } = node.props as { children?: unknown };
    return typeof children === 'string' ? [children] : [];
  });
}

/** Fill the URL and tap the start action; returns the handlers the start passed. */
function startReview(renderer: TestRenderer.ReactTestRenderer): StartMutationOptions {
  const [urlInput] = findAllOfType(renderer.root, 'TextInput');
  if (!urlInput) {
    throw new Error('Expected the URL field');
  }
  act(() => {
    (urlInput.props as { onChangeText: (value: string) => void }).onChangeText(GITHUB_PR_URL);
  });
  const [action] = findAllOfType(renderer.root, 'Button');
  if (!action) {
    throw new Error('Expected the start action');
  }
  act(() => {
    (action.props as { onPress: () => void }).onPress();
  });
  if (!startMutation.lastOptions?.onError) {
    throw new Error('Expected the start to reach the mutation');
  }
  return startMutation.lastOptions;
}

beforeEach(() => {
  status.connected = true;
  status.pending = false;
  startMutation.mutate.mockClear();
  startMutation.lastOptions = null;
});

describe('ManualReviewScreen start failure copy', () => {
  it('renders localized copy for a failed start instead of the server message', async () => {
    const { renderer, unmount } = await renderScreen();
    const handlers = startReview(renderer);

    act(() => handlers.onError?.(trpcError('NOT_FOUND', SERVER_NOT_FOUND)));

    const texts = renderedTexts(renderer);
    expect(texts).toContain(
      'GitHub could not find that pull request. Check the URL, or make sure the repository is public.'
    );
    expect(texts).not.toContain(SERVER_NOT_FOUND);
    // The recovery control stays beside the failure.
    expect(
      findAllOfType(renderer.root, 'Button').some(
        node => (node.props as { accessibilityLabel?: string }).accessibilityLabel === 'Retry'
      )
    ).toBe(true);

    unmount();
  });

  it('keeps the generic copy for an error code it does not map', async () => {
    const { renderer, unmount } = await renderScreen();
    const handlers = startReview(renderer);

    act(() => handlers.onError?.(trpcError('INTERNAL_SERVER_ERROR', 'boom')));

    expect(renderedTexts(renderer)).toContain('Unknown error');
    unmount();
  });

  it('names the connection for a transport failure with no code', async () => {
    const { renderer, unmount } = await renderScreen();
    const handlers = startReview(renderer);

    act(() => handlers.onError?.(new Error('Network request failed')));

    const texts = renderedTexts(renderer);
    expect(texts).toContain("Couldn't start the review. Check your connection and try again.");
    expect(texts).not.toContain('Network request failed');
    unmount();
  });

  it('still renders the stall copy for a deadline rejection', async () => {
    const { renderer, unmount } = await renderScreen();
    const handlers = startReview(renderer);

    const deadline = new Error('deadline');
    deadline.name = 'RequestDeadlineError';
    act(() => handlers.onError?.(Object.assign(deadline, { data: { code: 'NOT_FOUND' } })));

    const texts = renderedTexts(renderer);
    expect(texts).toContain(
      'This is taking longer than expected. You can close this and check again.'
    );
    expect(texts).not.toContain(
      'GitHub could not find that pull request. Check the URL, or make sure the repository is public.'
    );
    unmount();
  });
});
