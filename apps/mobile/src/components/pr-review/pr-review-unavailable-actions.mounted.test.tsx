import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { renderWithProviders } from '@/test/render-with-providers';
import { PrReviewUnavailableActions } from './pr-review-unavailable-actions';

const providerConnection = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
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
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
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
    act(() => {
      checkButton.props.onPress();
    });
    expect(providerConnection.mutate).toHaveBeenCalledWith({
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
    act(() => {
      check.props.onPress();
    });
    expect(providerConnection.mutate).toHaveBeenCalledWith({
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
