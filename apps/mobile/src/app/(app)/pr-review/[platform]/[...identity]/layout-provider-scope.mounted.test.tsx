import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { type ProviderPrScope } from '@/lib/pr-review/provider-pr-ref';
import ProviderPrReviewLayout from './_layout';

type RouteParams = Record<string, unknown>;

// The route params expo-router hands this layout: local params carry only the
// layout's own path segments, while the GitLab `?instance=` query param arrives
// through the global params. A layout that reads the query from its local
// params silently drops the pasted self-managed host.
const route = vi.hoisted((): { local: RouteParams; query: RouteParams } => ({
  local: { platform: 'gitlab', identity: ['group', 'repo', '3'] },
  query: { instance: 'https://gitlab.example.com' },
}));
const captured = vi.hoisted((): { scope: ProviderPrScope | null } => ({ scope: null }));

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  Stack: Object.assign(
    ({ children }: { children?: React.ReactNode }) => React.createElement('Stack', null, children),
    { Screen: 'StackScreen' }
  ),
  useLocalSearchParams: () => route.local,
  useGlobalSearchParams: () => route.query,
}));
vi.mock('@/components/app-screen-layout', () => ({
  appScreenLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement('ScreenLayout', null, children),
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/pr-review/pr-review-connect-gate', async () => {
  // A mock factory is hoisted above the static imports, so the module under
  // test is loaded here instead of at module scope.
  const providerRef = await import('@/lib/pr-review/provider-pr-ref');
  return {
    // Renders under the layout's scope provider, so this is the scope the gate
    // itself reads.
    PrReviewConnectGate: ({ children }: { children: React.ReactNode }) => {
      captured.scope = providerRef.useProviderPrScopeOrNull();
      return React.createElement('ConnectGate', null, children);
    },
  };
});
vi.mock('@/components/use-feedback-prompt', () => ({
  FeedbackPromptProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement('FeedbackPromptProvider', null, children),
}));
vi.mock('@/lib/form-sheet', () => ({ useFormSheetScreenOptions: () => ({}) }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: 'org-1' }),
}));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  pendingReviewDraftKey: () => 'owner/repo#3',
  PendingReviewProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement('PendingReviewProvider', null, children),
}));
vi.mock('react-native', () => ({ View: 'View' }));

function mount(): ProviderPrScope {
  act(() => {
    TestRenderer.create(<ProviderPrReviewLayout />);
  });
  const scope = captured.scope;
  if (!scope) {
    throw new Error('layout did not publish a scope');
  }
  return scope;
}

beforeEach(() => {
  route.local = { platform: 'gitlab', identity: ['group', 'repo', '3'] };
  route.query = { instance: 'https://gitlab.example.com' };
  captured.scope = null;
});

describe('provider PR-review layout scope', () => {
  it('publishes the pasted self-managed host from the route query', () => {
    const scope = mount();
    expect(scope.ref.platform).toBe('gitlab');
    expect(scope.ref).toMatchObject({ projectPath: 'group/repo', mrIid: 3 });
    expect(scope.ref.platform === 'gitlab' && scope.ref.instanceHint).toBe(
      'https://gitlab.example.com'
    );
  });

  it('drops a query value that is not an http(s) URL', () => {
    route.query = { instance: 'gitlab.example.com' };
    const scope = mount();
    expect(scope.ref.platform === 'gitlab' && scope.ref.instanceHint).toBeUndefined();
  });
});
