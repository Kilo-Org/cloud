// Boundary-state regression: four mutually exclusive settled states must map
// to four distinct copies. An account with no memberships gets the
// no-organization state whose action opens the web organizations page;
// memberships with nothing selected get the picker state whose action opens
// the context picker sheet; a deep-link override absent from a NON-empty
// member list is access-denied, while the same override against zero
// memberships is the no-organization state; a fetch failure is a retryable
// QueryError; a still resolving context is a spinner. A stale persisted
// selection (no override) keeps the older "unavailable" copy.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
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
    createElement('EmptyStateMock', null, props.title, props.description, props.action),
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
  Button: (props: { onPress?: () => void; children?: ReactNode }) =>
    createElement('ButtonMock', { onPress: props.onPress }, props.children),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

vi.mock('@/components/ui/icons', () => ({
  Building2: 'Building2',
  Globe: 'Globe',
}));

const openExternalUrlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/external-link', () => ({ openExternalUrl: openExternalUrlMock }));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://cloud.example.test' }));

const openPickerMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/context-control', () => ({
  useContextPicker: () => ({
    openPicker: openPickerMock,
    picker: createElement('ContextPickerSheetMock'),
  }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
}));

type BoundaryState = {
  organizationId: string | null;
  org: { organizationId: string } | undefined;
  orgs: { organizationId: string; organizationName: string }[] | undefined;
  isResolving: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

function boundaryState(overrides: Partial<BoundaryState> = {}): BoundaryState {
  return {
    organizationId: null,
    org: undefined,
    orgs: undefined,
    isResolving: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn<() => void>(),
    ...overrides,
  };
}

const Boundary = OrganizationBoundary as ComponentType<{
  organizationIdOverride?: string;
  title?: string;
}>;

function mountBoundary(
  organizationIdOverride?: string,
  title?: string
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Boundary, { organizationIdOverride, title }));
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
  openExternalUrlMock.mockReset();
  openPickerMock.mockReset();
});

describe('OrganizationBoundary settled states', () => {
  it.each([undefined, 'Organization'])(
    'renders the state without a scroller for title %s',
    title => {
      useOrgBoundaryMock.mockReturnValue(boundaryState());
      const renderer = mountBoundary(undefined, title);
      const state = renderer.root.find(node => String(node.type) === 'EmptyStateMock');
      expect(findByType(renderer.root, 'ScreenHeaderMock')).toHaveLength(title ? 1 : 0);
      expect(state).toBeDefined();
      act(() => {
        renderer.unmount();
      });
    }
  );

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

  it('renders access-denied when an override org is absent from a non-empty member list', () => {
    useOrgBoundaryMock.mockReturnValue(
      boundaryState({
        organizationId: 'org-missing',
        org: undefined,
        orgs: [{ organizationId: 'org-1', organizationName: 'Organization' }],
      })
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

  it('offers the web organizations page when the account has no organization', () => {
    useOrgBoundaryMock.mockReturnValue(boundaryState({ organizationId: null, orgs: [] }));

    const renderer = mountBoundary();
    const texts = collectText(renderer.toJSON());

    expect(findByType(renderer.root, 'EmptyStateMock')).toHaveLength(1);
    expect(texts).toContain('No organization');
    expect(texts).toContain(
      'This account is not part of an organization. Create or join one on the web to use organization features like member invites and low-balance alerts.'
    );
    expect(texts).toContain('Open organizations on web');
    expect(texts).toContain('Back to profile');
    expect(texts).not.toContain('Select an organization');

    const webButton = renderer.root.find(
      node =>
        String(node.type) === 'ButtonMock' &&
        collectText(node).includes('Open organizations on web')
    );
    expect(webButton).toBeDefined();
    act(() => {
      (webButton.props.onPress as (() => void) | undefined)?.();
    });
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://cloud.example.test/organizations', {
      label: 'Open organizations on web',
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('offers the web organizations page for a deep-link override with no memberships', () => {
    useOrgBoundaryMock.mockReturnValue(
      boundaryState({ organizationId: 'org-linked', org: undefined, orgs: [] })
    );

    const renderer = mountBoundary('org-linked');
    const texts = collectText(renderer.toJSON());

    expect(findByType(renderer.root, 'EmptyStateMock')).toHaveLength(1);
    expect(texts).toContain('No organization');
    expect(texts).toContain('Open organizations on web');
    expect(texts).toContain('Back to profile');
    expect(texts).not.toContain('Access denied');
    expect(texts).not.toContain('Select an organization');

    const webButton = renderer.root.find(
      node =>
        String(node.type) === 'ButtonMock' &&
        collectText(node).includes('Open organizations on web')
    );
    act(() => {
      (webButton.props.onPress as (() => void) | undefined)?.();
    });
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://cloud.example.test/organizations', {
      label: 'Open organizations on web',
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('opens the context picker when memberships exist but nothing is selected', () => {
    useOrgBoundaryMock.mockReturnValue(
      boundaryState({
        organizationId: null,
        orgs: [{ organizationId: 'org-1', organizationName: 'Organization' }],
      })
    );

    const renderer = mountBoundary();
    const texts = collectText(renderer.toJSON());

    expect(findByType(renderer.root, 'EmptyStateMock')).toHaveLength(1);
    expect(texts).toContain('Select an organization');
    expect(texts).toContain(
      'You belong to one or more organizations. Choose the account this screen should use.'
    );
    expect(texts).toContain('Choose an account');
    expect(texts).toContain('Back to profile');
    // The picker sheet element stays mounted in the caller's tree.
    expect(findByType(renderer.root, 'ContextPickerSheetMock')).toHaveLength(1);
    expect(texts).not.toContain('No organization');

    const chooseButton = renderer.root.find(
      node => String(node.type) === 'ButtonMock' && collectText(node).includes('Choose an account')
    );
    expect(chooseButton).toBeDefined();
    act(() => {
      (chooseButton.props.onPress as (() => void) | undefined)?.();
    });
    expect(openPickerMock).toHaveBeenCalledTimes(1);
    expect(openExternalUrlMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('opens the account picker for a stale selected org while memberships exist', () => {
    useOrgBoundaryMock.mockReturnValue(
      boundaryState({
        organizationId: 'org-stale',
        org: undefined,
        orgs: [{ organizationId: 'org-1', organizationName: 'Organization' }],
      })
    );

    const renderer = mountBoundary();
    const texts = collectText(renderer.toJSON());

    expect(texts).toContain('Select an organization');
    expect(texts).toContain('Choose an account');
    expect(findByType(renderer.root, 'ContextPickerSheetMock')).toHaveLength(1);
    expect(texts).not.toContain('Organization unavailable');
    expect(texts).not.toContain('Access denied');

    act(() => {
      renderer.unmount();
    });
  });

  it('falls back to the no-organization state when a stale selection has no memberships left', () => {
    useOrgBoundaryMock.mockReturnValue(boundaryState({ organizationId: 'org-stale', orgs: [] }));

    const renderer = mountBoundary();
    const texts = collectText(renderer.toJSON());

    expect(texts).toContain('No organization');
    expect(texts).toContain('Open organizations on web');
    expect(texts).not.toContain('Organization unavailable');
    expect(texts).not.toContain('Select an organization');

    act(() => {
      renderer.unmount();
    });
  });
});
