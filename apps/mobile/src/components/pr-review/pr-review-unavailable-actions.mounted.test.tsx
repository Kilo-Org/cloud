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
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
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

async function mount(scope: ProviderPrScope) {
  const mounted = await renderWithProviders(
    <ProviderPrScopeProvider value={scope}>
      {createElement(PrReviewUnavailableActions, {
        onRetry: () => {
          onRetry();
        },
        isRetrying: false,
      })}
    </ProviderPrScopeProvider>
  );
  return mounted;
}

type ButtonInstance = {
  props: {
    onPress: () => void;
    children: { props: { children: string } };
  };
};

function findButtons(renderer: { root: { findAll: (f: (n: unknown) => boolean) => unknown[] } }) {
  return renderer.root.findAll(
    node => String((node as { type: unknown }).type) === 'Button'
  ) as ButtonInstance[];
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
    expect(retryButton.props.children.props.children).toBe('Retry');
    expect(checkButton.props.children.props.children).toBe('Check connection');
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
