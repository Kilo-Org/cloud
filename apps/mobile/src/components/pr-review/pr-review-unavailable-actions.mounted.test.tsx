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
vi.mock('@/components/empty-state', () => ({ StateAction: 'StateAction' }));
vi.mock('@/components/ui/icons', () => ({ PlugZap: 'PlugZap', RotateCcw: 'RotateCcw' }));
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
    emphasis?: string;
    label?: string;
    accessibilityLabel?: string;
  };
};

type HostNode = { type: unknown };

/** Narrows a renderer node to its host `type`, the field the string mocks above set. */
function isHostNode(node: unknown): node is HostNode {
  return typeof node === 'object' && node !== null && 'type' in node;
}

/** The state's recovery actions in render order: the retry, then the check. */
function findActions(renderer: { root: { findAll: (f: (n: unknown) => boolean) => unknown[] } }) {
  return renderer.root.findAll(
    node => isHostNode(node) && String(node.type) === 'StateAction'
  ) as ActionInstance[];
}

/** The row's own root: the only `View` the component draws. */
type RowRoot = { props: { className?: string } };

function findRowRoot(renderer: { root: { findAll: (f: (n: unknown) => boolean) => unknown[] } }) {
  const roots = renderer.root.findAll(
    node => isHostNode(node) && String(node.type) === 'View'
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
    const actions = findActions(renderer);
    expect(actions).toHaveLength(2);
    const [retryAction, checkAction] = actions;
    if (!retryAction || !checkAction) {
      throw new Error('the two recovery actions did not render');
    }
    // The retry is the shared state action that carries the recovery; the
    // provider check is the same frame at the quiet weight under it, so the
    // state does not offer two equal choices.
    expect(String(retryAction.type)).toBe('StateAction');
    expect(retryAction.props.label).toBe('Retry');
    expect(String(checkAction.type)).toBe('StateAction');
    expect(checkAction.props.accessibilityLabel).toBe('Check connection');
    expect(checkAction.props.emphasis).toBe('quiet');
    act(() => {
      retryAction.props.onPress();
    });
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => {
      checkAction.props.onPress();
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
    const actions = findActions(renderer);
    const check = actions[1];
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
    expect(findActions(renderer)).toHaveLength(0);
    unmount();
  });

  it('leads with the brand fill only on the whole-surface row', async () => {
    const scope: ProviderPrScope = {
      ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
      organizationId: null,
    };
    const embedded = await mount(scope, 'embedded');
    const [embeddedRetry, embeddedCheck] = findActions(embedded.renderer);
    if (!embeddedRetry || !embeddedCheck) {
      throw new Error('the two recovery actions did not render');
    }
    // The overview body this row rides already owns its primary — the Merge
    // CTA — so both controls of the card take the same quiet face and the card
    // adds no second brand fill.
    expect(embeddedRetry.type).toBe('StateAction');
    expect(embeddedRetry.props.emphasis).toBe('quiet');
    expect(embeddedCheck.props.emphasis).toBe('quiet');
    // The card's own gap spaces the embedded row, so the appended margin a
    // whole-surface row needs would double it.
    expect(String(findRowRoot(embedded.renderer).props.className)).not.toContain('mt-3');
    embedded.unmount();

    const surface = await mount(scope);
    const [surfaceRetry, surfaceCheck] = findActions(surface.renderer);
    if (!surfaceRetry || !surfaceCheck) {
      throw new Error('the two recovery actions did not render');
    }
    // Where the row is the whole surface it is the one action there, so the
    // same shared state action keeps its brand fill and the check stays quiet
    // under it.
    expect(surfaceRetry.type).toBe(embeddedRetry.type);
    expect(surfaceRetry.props.emphasis).toBeUndefined();
    expect(surfaceCheck.props.emphasis).toBe('quiet');
    expect(String(findRowRoot(surface.renderer).props.className)).toContain('mt-3');
    surface.unmount();
  });

  it.each([
    ['embedded', 'embedded'],
    ['surface', undefined],
  ])('stacks both controls on one width in the %s row', async (_label, presentation) => {
    const scope: ProviderPrScope = {
      ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
      organizationId: null,
    };
    const { renderer, unmount } = await mount(scope, presentation as 'embedded' | undefined);
    // A centred, content-sized column shrinks each control to its own label,
    // which is what left the pair as one narrow retry and one wider check. The
    // column keeps the default cross-axis stretch, so both controls share the
    // width of the wider one.
    expect(String(findRowRoot(renderer).props.className)).not.toContain('items-center');
    unmount();
  });
});

describe('PrReviewUnavailableActions — check outcome', () => {
  /** Presses Check connection and settles it with the given answer. */
  async function runCheck(scope: ProviderPrScope, status: ProviderConnectionStatus) {
    toastMock.mockClear();
    providerConnection.mutateAsync.mockResolvedValue(status);
    const { renderer, unmount } = await mount(scope);
    const check = findActions(renderer)[1];
    if (!check) {
      throw new Error('the connection check action did not render');
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
