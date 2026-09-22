import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { TestRenderer } from '@/test/renderer';

import { renderProfileRow } from './new-session-profile-row';
import { useEffectiveAgentProfile } from './use-effective-agent-profile';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentProfiles: {
      list: { queryOptions: () => ({ queryKey: ['personal-profiles'] }) },
      listCombined: { queryOptions: () => ({ queryKey: ['combined-profiles'] }) },
    },
  }),
}));

type RowProps = Parameters<typeof renderProfileRow>[0];

const PROFILE = {
  id: 'profile-1',
  name: 'Production',
  commandCount: 3,
  mcpServerCount: 1,
  skillCount: 2,
  agentCount: 4,
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let client: QueryClient | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  client?.clear();
  client = undefined;
});

function QueryProfileRow({ organizationId }: { organizationId?: string }): ReactNode {
  const result = useEffectiveAgentProfile(organizationId);
  return renderProfileRow({
    t: i18n.t.bind(i18n),
    profile: result.profile,
    isProfileLoading: result.isLoading,
    isProfileError: result.isError,
    onRetryProfile: () => {
      void result.refetch();
    },
  });
}

function renderRow(overrides: Partial<RowProps> = {}) {
  const element = (
    <>
      {renderProfileRow({
        t: i18n.t.bind(i18n),
        profile: null,
        isProfileLoading: false,
        isProfileError: false,
        onRetryProfile: vi.fn<() => void>(),
        ...overrides,
      })}
    </>
  );
  TestRenderer.act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Profile row did not mount');
  }
  return renderer.root;
}

function text(root: TestRenderer.ReactTestInstance) {
  return root.findAllByType('Text').map(node => node.props.children);
}

function body(root: TestRenderer.ReactTestInstance) {
  return root.findByProps({ className: 'min-w-0 flex-1 gap-1' });
}

describe('new-session environment feedback', () => {
  it('renders loading feedback immediately without a false default, stale profile, or Retry', () => {
    const root = renderRow({ isProfileLoading: true, profile: PROFILE });

    expect(text(root)).toEqual(['Environment', 'Loading…', '\u00A0']);
    expect(root.findByProps({ children: 'Loading…' }).props).toMatchObject({
      accessibilityLiveRegion: 'polite',
      accessibilityState: { busy: true },
    });
    expect(root.findAllByType('Skeleton')).toHaveLength(1);
    expect(root.findAllByType('Button')).toHaveLength(0);
  });

  it('shows the resolved profile and summary without a loading indicator or extra action', () => {
    const root = renderRow({ profile: PROFILE });

    expect(text(root)).toEqual([
      'Environment',
      'Production',
      '3 commands · 1 MCP · 2 skills · 4 agents',
    ]);
    expect(root.findAllByType('Skeleton')).toHaveLength(0);
    expect(root.findAllByType('Button')).toHaveLength(0);
  });

  it('shows the default only after the query settles empty and hides the blank slot from accessibility', () => {
    const root = renderRow();

    expect(text(root)).toEqual(['Environment', 'Default environment', '\u00A0']);
    expect(
      root.findByProps({ importantForAccessibility: 'no-hide-descendants' }).props
    ).toMatchObject({
      accessibilityElementsHidden: true,
    });
    expect(root.findAllByType('Skeleton')).toHaveLength(0);
    expect(root.findAllByType('Button')).toHaveLength(0);
  });

  it('retries a failed request and replaces the error in place with loading and then content', () => {
    const onRetryProfile = vi.fn<() => void>();
    const root = renderRow({ isProfileError: true, onRetryProfile });
    const slot = body(root);

    expect(text(root)).toContain("Couldn't load your environment");
    const retry = root.findByType('Button');
    expect(retry.props.accessibilityLabel).toBe('Retry loading environment');
    const onPress = retry.props.onPress as () => void;
    TestRenderer.act(onPress);
    expect(onRetryProfile).toHaveBeenCalledExactlyOnceWith();

    const pending = renderRow({ isProfileLoading: true, isProfileError: true });
    expect(body(pending)).toBe(slot);
    expect(text(pending)).toContain('Loading…');
    expect(text(pending)).not.toContain("Couldn't load your environment");
    expect(pending.findAllByType('Button')).toHaveLength(0);

    const ready = renderRow({ profile: PROFILE });
    expect(body(ready)).toBe(slot);
    expect(text(ready)).toContain('Production');
    expect(ready.findByProps({ children: 'Production' }).props.accessibilityState).toEqual({
      busy: false,
    });
  });

  it.each([{ isProfileLoading: true }, { profile: PROFILE }, { isProfileError: true }, {}])(
    'keeps two font-scaled text lines reserved across a state swap: %j',
    next => {
      const pending = renderRow({ isProfileLoading: true });
      const slot = body(pending);
      expect(pending.findByType('Skeleton').props.className).toContain('absolute inset-y-0');

      const root = renderRow(next);
      expect(body(root)).toBe(slot);
      expect(
        root.findByProps({ className: 'min-h-[36px] flex-row items-center gap-2' })
      ).toBeTruthy();
      const lines = slot.findAllByType('Text');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.props.numberOfLines).toBe(1);
        expect(line.props.className).toContain('text-sm leading-5');
        expect(line.props.children).not.toBe('');
      }
    }
  );

  describe.each([
    { context: 'personal', organizationId: undefined, queryKey: ['personal-profiles'] },
    { context: 'organization', organizationId: 'org-1', queryKey: ['combined-profiles'] },
  ])('$context cached profile', ({ organizationId, queryKey }) => {
    it.each(['profile', 'empty', 'error'] as const)(
      'shows loading during Retry and settles to %s without remounting',
      async outcome => {
        const profiles = [{ ...PROFILE, isDefault: true }];
        const data = organizationId
          ? { personalProfiles: profiles, orgProfiles: [], effectiveDefaultId: PROFILE.id }
          : profiles;
        const empty = organizationId
          ? { personalProfiles: [], orgProfiles: [], effectiveDefaultId: null }
          : [];
        const refresh = Promise.withResolvers<unknown>();
        const retry = Promise.withResolvers<unknown>();
        const queryFn = vi
          .fn()
          .mockReturnValueOnce(refresh.promise)
          .mockReturnValueOnce(retry.promise);
        const queryClient = new QueryClient({
          defaultOptions: { queries: { queryFn, retry: false, gcTime: Infinity } },
        });
        client = queryClient;
        queryClient.setQueryData(queryKey, data);
        TestRenderer.act(() => {
          renderer = TestRenderer.create(
            <QueryClientProvider client={queryClient}>
              <QueryProfileRow organizationId={organizationId} />
            </QueryClientProvider>
          );
        });
        if (!renderer) {
          throw new Error('Profile row did not mount');
        }
        const root = renderer.root;
        const slot = body(root);

        // A normal background refresh must keep the successful cached profile visible.
        expect(text(root)).toContain('Production');
        expect(root.findAllByType('Skeleton')).toHaveLength(0);
        TestRenderer.act(() => {
          refresh.reject(new Error('Profile request failed'));
        });
        await vi.waitFor(() => {
          expect(text(root)).toContain("Couldn't load your environment");
        });

        const onPress = root.findByType('Button').props.onPress as () => void;
        TestRenderer.act(onPress);
        await vi.waitFor(() => {
          expect(queryFn).toHaveBeenCalledTimes(2);
        });
        expect(queryClient.getQueryState(queryKey)).toMatchObject({
          status: 'error',
          fetchStatus: 'fetching',
          data,
        });
        await vi.waitFor(() => {
          expect(text(root)).toContain('Loading…');
        });
        expect(text(root)).not.toContain("Couldn't load your environment");
        expect(text(root)).not.toContain('Production');
        expect(root.findAllByType('Button')).toHaveLength(0);
        expect(root.findAllByType('Skeleton')).toHaveLength(1);
        expect(body(root)).toBe(slot);

        TestRenderer.act(() => {
          if (outcome === 'error') {
            retry.reject(new Error('Retry failed'));
          } else {
            retry.resolve(outcome === 'empty' ? empty : data);
          }
        });
        const title = {
          error: "Couldn't load your environment",
          empty: 'Default environment',
          profile: 'Production',
        }[outcome];
        await vi.waitFor(() => {
          expect(text(root)).toContain(title);
        });
        expect(root.findAllByType('Button')).toHaveLength(outcome === 'error' ? 1 : 0);
        expect(root.findAllByType('Skeleton')).toHaveLength(0);
        expect(body(root)).toBe(slot);
      }
    );
  });
});
