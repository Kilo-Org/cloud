/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); same pattern as src/test/render-with-providers.tsx. */

// Boundary-state regression: three mutually exclusive settled states must map
// to three distinct copies. A deep-link override that is absent from the member
// list is access-denied, a fetch failure is a retryable QueryError, and a still
// resolving context is a spinner. A stale persisted selection (no override)
// keeps the older "unavailable" copy.

import { type ComponentType, createElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { OrganizationBoundary } from './organization-boundary';

const useOrgBoundaryMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: (...args: unknown[]) => useOrgBoundaryMock(...args),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title?: string; description?: ReactNode; action?: ReactNode }) =>
    createElement('EmptyStateMock', null, [props.title, props.description, props.action]),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: { title?: string; onRetry?: () => void }) =>
    createElement('QueryErrorMock', null, [
      props.title,
      props.onRetry != null ? 'HAS_RETRY' : null,
    ]),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string }) => createElement('ScreenHeaderMock', null, props.title),
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: ReactNode }) => createElement('ButtonMock', null, props.children),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
}));

type BoundaryState = {
  organizationId: string | null;
  org: { organizationId: string } | undefined;
  isResolving: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

function boundaryState(overrides: Partial<BoundaryState> = {}): BoundaryState {
  return {
    organizationId: null,
    org: undefined,
    isResolving: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn<() => void>(),
    ...overrides,
  };
}

const Boundary = OrganizationBoundary as ComponentType<{ organizationIdOverride?: string }>;

function mountBoundary(organizationIdOverride?: string): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Boundary, { organizationIdOverride }));
  });
  if (!ref.current) {
    throw new Error('boundary did not render');
  }
  return ref.current;
}

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

beforeEach(() => {
  useOrgBoundaryMock.mockReset();
});

describe('OrganizationBoundary settled states', () => {
  it('renders a spinner while the org context is resolving', () => {
    useOrgBoundaryMock.mockReturnValue(boundaryState({ isResolving: true }));

    const renderer = mountBoundary();

    expect(findByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);
    expect(findByType(renderer.root, 'EmptyStateMock')).toHaveLength(0);
    expect(findByType(renderer.root, 'QueryErrorMock')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders a retryable QueryError when the org list fetch fails', () => {
    useOrgBoundaryMock.mockReturnValue(boundaryState({ organizationId: 'org-1', isError: true }));

    const renderer = mountBoundary();

    expect(findByType(renderer.root, 'QueryErrorMock')).toHaveLength(1);
    expect(collectText(renderer.toJSON())).toContain("Couldn't load your organizations");
    expect(collectText(renderer.toJSON())).toContain('HAS_RETRY');

    act(() => {
      renderer.unmount();
    });
  });

  it('renders access-denied when an override org is absent from the member list', () => {
    useOrgBoundaryMock.mockReturnValue(
      boundaryState({ organizationId: 'org-missing', org: undefined })
    );

    const renderer = mountBoundary('org-missing');
    const texts = collectText(renderer.toJSON());

    expect(findByType(renderer.root, 'EmptyStateMock')).toHaveLength(1);
    expect(texts).toContain('Access denied');
    expect(texts).toContain('You do not have access to this organization.');
    expect(texts).toContain('Back to profile');
    expect(texts).not.toContain('Organization unavailable');

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the unavailable copy for a stale selected org with no override', () => {
    useOrgBoundaryMock.mockReturnValue(
      boundaryState({ organizationId: 'org-stale', org: undefined })
    );

    const renderer = mountBoundary();
    const texts = collectText(renderer.toJSON());

    expect(texts).toContain('Organization unavailable');
    expect(texts).toContain(
      'This organization is no longer available. Choose one from your profile to continue.'
    );
    expect(texts).not.toContain('Access denied');

    act(() => {
      renderer.unmount();
    });
  });
});
