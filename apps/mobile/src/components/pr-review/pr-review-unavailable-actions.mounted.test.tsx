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

function mount(scope: ProviderPrScope) {
  return renderWithProviders(
    <ProviderPrScopeProvider value={scope}>
      {createElement(PrReviewUnavailableActions, { onRetry, isRetrying: false })}
    </ProviderPrScopeProvider>
  );
}

describe('PrReviewUnavailableActions', () => {
  it('renders Retry and Check connection for a GitLab scope and wires both', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
      organizationId: null,
    };
    const { renderer, unmount } = await mount(scope);
    const buttons = renderer.root.findAll(node => String(node.type) === 'Button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].props.children.props.children).toBe('Retry');
    expect(buttons[1].props.children.props.children).toBe('Check connection');
    act(() => {
      buttons[0].props.onPress();
    });
    expect(onRetry).toHaveBeenCalledOnce();
    act(() => {
      buttons[1].props.onPress();
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
    const check = renderer.root.findAll(node => String(node.type) === 'Button')[1];
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
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
    unmount();
  });
});
