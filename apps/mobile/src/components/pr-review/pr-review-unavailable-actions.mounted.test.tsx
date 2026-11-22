import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { type ProviderConnectionStatus } from '@/lib/pr-review/use-check-provider-connection';
import { renderWithProviders } from '@/test/render-with-providers';
import { PrReviewUnavailableActions } from './pr-review-unavailable-actions';

const providerConnection = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock('@/lib/pr-review/use-check-provider-connection', () => ({
  useCheckProviderConnection: () => providerConnection,
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/empty-state', () => ({ StateAction: 'StateAction' }));
vi.mock('@/components/ui/icons', () => ({ PlugZap: 'PlugZap', RotateCcw: 'RotateCcw' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    providerReview: { pathFilter: () => ({ queryKey: [['providerReview']] }) },
    organizations: {
      reviewAgent: {
        getGitLabStatus: { queryOptions: () => ({}) },
        getBitbucketReadiness: { queryOptions: () => ({}) },
      },
    },
    personalReviewAgent: { getGitLabStatus: { queryOptions: () => ({}) } },
  }),
}));

const onRetry = vi.fn();

beforeEach(() => {
  providerConnection.mutateAsync.mockReset();
  providerConnection.mutateAsync.mockResolvedValue({ connected: false, instanceUrl: null });
});

async function mount(scope: ProviderPrScope, presentation?: 'surface' | 'embedded') {
  const mounted = await renderWithProviders(
    <ProviderPrScopeProvider value={scope}>
      {createElement(PrReviewUnavailableActions, {
        onRetry: () => {
          onRetry();
        },
        isRetrying: false,
        presentation,
      })}
    </ProviderPrScopeProvider>
  );
  return mounted;
}

type ActionInstance = {
  type: unknown;
  props: {
    onPress: () => void;
    variant?: string;
    emphasis?: string;
    label?: string;
    accessibilityLabel?: string;
  };
};

/** The state's recovery actions in render order: the retry, then the check. */
function findButtons(renderer: { root: { findAll: (f: (n: unknown) => boolean) => unknown[] } }) {
  return renderer.root.findAll(node =>
    ['StateAction', 'Button'].includes(String((node as { type: unknown }).type))
  ) as ActionInstance[];
}

/** The row's own root: the only `View` the component draws. */
type RowRoot = { props: { className?: string } };

function findRowRoot(renderer: { root: { findAll: (f: (n: unknown) => boolean) => unknown[] } }) {
  const roots = renderer.root.findAll(
    node => String((node as { type: unknown }).type) === 'View'
  ) as RowRoot[];
  const [root] = roots;
  if (!root) {
    throw new Error('the recovery row drew no root');
  }
  return root;
}

describe('PrReviewUnavailableActions', () => {
  it('renders Retry and Check connection for a GitLab scope and wires both', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
      organizationId: null,
    };
    const { renderer, unmount } = await mount(scope);
    const buttons = findButtons(renderer);
    expect(buttons).toHaveLength(2);
    const [retryButton, checkButton] = buttons;
    if (!retryButton || !checkButton) {
      throw new Error('the two recovery buttons did not render');
    }
    // The retry is the shared state action, the one primary that carries the
    // recovery; the provider check stays the outlined control under it, so the
    // state does not offer two equal choices.
    expect(String(retryButton.type)).toBe('StateAction');
    expect(retryButton.props.label).toBe('Retry');
    expect(String(checkButton.type)).toBe('Button');
    expect(checkButton.props.accessibilityLabel).toBe('Check connection');
    expect(checkButton.props.variant).toBe('outline');
    act(() => {
      retryButton.props.onPress();
    });
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => {
      checkButton.props.onPress();
      await Promise.resolve();
    });
    expect(providerConnection.mutateAsync).toHaveBeenCalledWith({
      platform: 'gitlab',
      organizationId: null,
    });
    unmount();
  });

  it('carries the selected organization into the connection check', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 3 },
      organizationId: 'org_1',
    };
    const { renderer, unmount } = await mount(scope);
    const buttons = findButtons(renderer);
    const check = buttons[1];
    if (!check) {
      throw new Error('the connection check button did not render');
    }
    await act(async () => {
      check.props.onPress();
      await Promise.resolve();
    });
    expect(providerConnection.mutateAsync).toHaveBeenCalledWith({
      platform: 'bitbucket',
      organizationId: 'org_1',
    });
    unmount();
  });

  it('renders nothing on a GitHub fallback scope', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'github', owner: 'org', repo: 'repo', number: 1 },
      organizationId: null,
    };
    const { renderer, unmount } = await mount(scope);
    expect(findButtons(renderer)).toHaveLength(0);
    unmount();
  });

  it('paints both embedded controls on the outlined face', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
      organizationId: null,
    };
    const { renderer, unmount } = await mount(scope, 'embedded');
    const [retryButton, checkButton] = findButtons(renderer);
    if (!retryButton || !checkButton) {
      throw new Error('the two recovery buttons did not render');
    }
    // Neither control takes the brand fill: the body the row is embedded in
    // owns its primary. The retry asks for the quiet emphasis, which paints the
    // outlined control, and the check keeps that same face. Both show one box
    // edge, so the gap above the row and the gap inside it read as the same
    // distance; a ghost check hides its own 48pt box and the row looked
    // unevenly spaced.
    expect(retryButton.props.emphasis).toBe('quiet');
    expect(checkButton.props.variant).toBe('outline');
    // The card's own gap spaces the row, so the appended margin a whole-surface
    // row needs would double it.
    expect(String(findRowRoot(renderer).props.className)).not.toContain('mt-3');
    unmount();
  });

  it('keeps the whole-surface row on its filled retry and outlined check', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
      organizationId: null,
    };
    const { renderer, unmount } = await mount(scope);
    const [retryButton, checkButton] = findButtons(renderer);
    if (!retryButton || !checkButton) {
      throw new Error('the two recovery buttons did not render');
    }
    // No emphasis override: the state action keeps the filled default face.
    expect(retryButton.props.emphasis).toBeUndefined();
    expect(checkButton.props.variant).toBe('outline');
    expect(String(findRowRoot(renderer).props.className)).toContain('mt-3');
    unmount();
  });
});

describe('PrReviewUnavailableActions — check outcome', () => {
  /** Presses Check connection and settles it with the given answer. */
  async function runCheck(scope: ProviderPrScope, status: ProviderConnectionStatus) {
    toastMock.mockClear();
    providerConnection.mutateAsync.mockResolvedValue(status);
    const { renderer, unmount } = await mount(scope);
    const check = findButtons(renderer)[1];
    if (!check) {
      throw new Error('the connection check button did not render');
    }
    await act(async () => {
      check.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    unmount();
  }

  const SELF_MANAGED: ProviderPrScope = {
    ref: {
      platform: 'gitlab',
      projectPath: 'group/repo',
      mrIid: 18,
      instanceHint: 'https://gitlab.example.com',
    },
    organizationId: null,
  };

  it('says the connection is fine when it still cannot serve the item', async () => {
    await runCheck(SELF_MANAGED, {
      connected: true,
      instanceUrl: 'https://gitlab.example.com',
    });
    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      "Connection is active, but this item still can't be loaded."
    );
  });

  it('leaves the outcome to the gate when the connection is for another instance', async () => {
    await runCheck(SELF_MANAGED, { connected: true, instanceUrl: 'https://gitlab.com' });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('leaves the outcome to the gate when there is no connection at all', async () => {
    await runCheck(SELF_MANAGED, { connected: false, instanceUrl: null });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('reports a fine Bitbucket connection — one host, nothing to compare', async () => {
    await runCheck(
      {
        ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 3 },
        organizationId: 'org_1',
      },
      { connected: true, instanceUrl: null }
    );
    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      "Connection is active, but this item still can't be loaded."
    );
  });
});
