import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { useRepoBindings } from '@/lib/hooks/use-repo-bindings';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  listRepoBindings: vi.fn(),
  inputs: undefined as unknown,
}));

vi.mock('@/lib/trpc', () => {
  const trpc = {
    agentProfiles: {
      pathFilter: () => ({ queryKey: ['agentProfiles'] }),
      listRepoBindings: {
        pathFilter: () => ({ queryKey: ['agentProfiles', 'listRepoBindings'] }),
        queryKey: (input: unknown) => ['agentProfiles', 'listRepoBindings', input],
        queryOptions: (input: unknown) => {
          mocks.inputs = input;
          return {
            queryKey: ['agentProfiles', 'listRepoBindings', input],
            queryFn: () => mocks.listRepoBindings(),
          };
        },
      },
      bindToRepo: {
        pathFilter: () => ({ queryKey: ['agentProfiles', 'listRepoBindings'] }),
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: vi.fn(),
        }),
      },
      unbindRepo: {
        pathFilter: () => ({ queryKey: ['agentProfiles', 'listRepoBindings'] }),
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: vi.fn(),
        }),
      },
    },
  };
  return { useTRPC: () => trpc };
});

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

// ── Helpers ────────────────────────────────────────────────────────────────

type BindingsResult = ReturnType<typeof useRepoBindings>;

function binding(repoFullName: string): BindingsResult['bindings'][number] {
  return { repoFullName, platform: 'github', profileId: 'profile-1', profileName: 'Backend' };
}

function BindingsProbe({
  holder,
  organizationId,
}: {
  holder: { current: BindingsResult | null };
  organizationId?: string;
}) {
  holder.current = useRepoBindings(organizationId);
  return null;
}

function current(holder: { current: BindingsResult | null }): BindingsResult {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useRepoBindings', () => {
  beforeEach(() => {
    mocks.listRepoBindings.mockReset().mockResolvedValue([]);
    mocks.inputs = undefined;
  });

  it('starts empty on an organization switch instead of keeping the prior rows', async () => {
    const first = Promise.withResolvers<BindingsResult['bindings']>();
    const second = Promise.withResolvers<BindingsResult['bindings']>();
    mocks.listRepoBindings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const holder: { current: BindingsResult | null } = { current: null };
    const { renderer, queryClient, unmount } = await renderWithProviders(
      createElement(BindingsProbe, { holder, organizationId: 'org-1' })
    );

    first.resolve([binding('org-1/api')]);
    await waitFor(() => current(holder).bindings.length === 1);

    // Switch context while the new organization's read is still pending. The
    // previous organization's bindings must not render under the new scope,
    // because the unbind mutation now carries the newly selected organization.
    await act(async () => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(BindingsProbe, { holder, organizationId: 'org-2' })
        )
      );
      await Promise.resolve();
    });

    expect(current(holder).bindings).toEqual([]);
    expect(current(holder).isLoading).toBe(true);

    second.resolve([binding('org-2/api')]);
    await waitFor(
      () =>
        current(holder)
          .bindings.map(row => row.repoFullName)
          .join(',') === 'org-2/api'
    );
    unmount();
  });

  it('reads the personal context without an organizationId', async () => {
    const holder: { current: BindingsResult | null } = { current: null };
    const { unmount } = await renderWithProviders(createElement(BindingsProbe, { holder }));

    await waitFor(() => mocks.listRepoBindings.mock.calls.length > 0);
    expect(mocks.inputs).toEqual({});
    unmount();
  });
});
