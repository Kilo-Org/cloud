import { QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { vi } from 'vitest';

import '@/i18n';
import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const createMutate = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const boundaryRefetch = vi.hoisted(() => vi.fn());
type BoundaryOrgRow = { organizationId: string; role: string };
const boundaryState = vi.hoisted(() => {
  const state: {
    organizationId: string | null;
    org: { organizationName: string } | undefined;
    role: string | undefined;
    isResolving: boolean;
    isError: boolean;
    isFetching: boolean;
    selectionSettled: boolean;
    orgs: BoundaryOrgRow[] | undefined;
    refetch: typeof boundaryRefetch;
  } = {
    organizationId: 'org-1',
    org: { organizationName: 'First test organization' },
    role: 'owner',
    isResolving: false,
    isError: false,
    isFetching: false,
    selectionSettled: true,
    orgs: [{ organizationId: 'org-1', role: 'owner' }],
    refetch: boundaryRefetch,
  };
  return state;
});
const mutationState = vi.hoisted(() => ({
  create: { mutateAsync: createMutate, isPending: false },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileMutations: () => mutationState,
}));

vi.mock('sonner-native', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => false, back: () => undefined }),
}));

// The post-create hand-off goes through the push-then-retire hook that keeps
// Android Fabric alive. Its own mechanics have their own suite, so here the
// hook stands in for the navigation call and the assertions stay about the
// destination href.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: routerReplace }),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundaryState,
}));

// The stored selection settles through the provider; here its published
// `isLoaded` stands in, so a test can mount the screen before the selection
// names anything.
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ isLoaded: boundaryState.selectionSettled }),
}));

vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfileOverviewPath: (profileId: string, options: { organizationId?: string } = {}) =>
    options.organizationId
      ? `/profiles/${profileId}?org=${options.organizationId}`
      : `/profiles/${profileId}`,
}));

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The shared retry row has its own suite; here it passes its props through so a
// test can read the retry callback the screen handed it and press it.
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    placement?: string;
    inset?: string;
    compact?: boolean;
    isRetrying?: boolean;
    onRetry?: () => void;
  }) => createElement('QueryError', props),
}));

// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { boundaryRefetch, boundaryState, createMutate, routerReplace, toastError, toastSuccess };

export function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

export function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

export function findOwnerControl(root: ReactTestInstance): ReactTestInstance {
  const control = findAll(root, 'SegmentedControl')[0];
  if (!control) {
    throw new Error('owner control was not rendered');
  }
  return control;
}

export function typeName(root: ReactTestInstance, name: string): void {
  act(() => {
    (findField(root, 'Profile name').props as { onChangeText: (v: string) => void }).onChangeText(
      name
    );
  });
}

export async function mount() {
  const result = await renderWithProviders(
    createElement(NewProfileScreen, { stack: 'profileTab' })
  );
  const rerender = () => {
    act(() => {
      result.renderer.update(
        createElement(
          QueryClientProvider,
          { client: result.queryClient },
          createElement(NewProfileScreen, { stack: 'profileTab' })
        )
      );
    });
  };
  return { ...result, rerender };
}

export async function pressCreate(root: ReactTestInstance): Promise<void> {
  const button = findAll(root, 'Button')[0];
  if (!button) {
    throw new Error('create button was not rendered');
  }
  await act(async () => {
    (button.props as { onPress: () => void }).onPress();
    await Promise.resolve();
  });
}

/** The one Create button, so a test can read whether the screen disabled it. */
export function findCreateButton(root: ReactTestInstance): ReactTestInstance {
  const button = findAll(root, 'Button')[0];
  if (!button) {
    throw new Error('create button was not rendered');
  }
  return button;
}

/** The boundary read's retry row, or `undefined` while the read has not failed. */
export function findRetryRow(root: ReactTestInstance): ReactTestInstance | undefined {
  return findAll(root, 'QueryError')[0];
}

/** Put the boundary, the mocks and the create result back to the suite's baseline. */
export function resetNewProfileState(): void {
  createMutate.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  routerReplace.mockReset();
  boundaryRefetch.mockReset();
  createMutate.mockResolvedValue({ id: 'profile-1' });
  boundaryState.organizationId = 'org-1';
  boundaryState.role = 'owner';
  boundaryState.org = { organizationName: 'First test organization' };
  boundaryState.isResolving = false;
  boundaryState.isError = false;
  boundaryState.isFetching = false;
  boundaryState.selectionSettled = true;
  boundaryState.orgs = [{ organizationId: 'org-1', role: 'owner' }];
  mutationState.create.isPending = false;
}
