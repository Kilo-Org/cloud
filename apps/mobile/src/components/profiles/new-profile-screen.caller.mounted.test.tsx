import { createElement } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const createMutate = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const routerCanGoBack = vi.hoisted(() => ({ value: true }));
const boundaryArgs = vi.hoisted((): { value: (string | undefined)[] } => ({ value: [] }));
const boundaryState = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  org: { organizationName: 'First test organization' },
  role: 'owner' as string | undefined,
  isResolving: false,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileMutations: () => ({ create: { mutateAsync: createMutate, isPending: false } }),
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    replace: routerReplace,
    back: routerBack,
    canGoBack: () => routerCanGoBack.value,
  }),
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: (organizationId?: string) => {
    boundaryArgs.value.push(organizationId);
    return boundaryState;
  },
}));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfileOverviewPath: (profileId: string, organizationId?: string) =>
    organizationId ? `/profiles/${profileId}?org=${organizationId}` : `/profiles/${profileId}`,
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function typeName(root: ReactTestInstance, name: string): void {
  const field = findAll(root, 'FormField').find(node => node.props.label === 'Profile name');
  if (!field) {
    throw new Error('profile name field was not rendered');
  }
  act(() => {
    (field.props as { onChangeText: (value: string) => void }).onChangeText(name);
  });
}

function mount(props: {
  initialOwner?: 'personal' | 'organization';
  returnToCaller?: boolean;
  organizationId?: string;
}) {
  return renderWithProviders(createElement(NewProfileScreen, { stack: 'app', ...props }));
}

async function pressCreate(root: ReactTestInstance): Promise<void> {
  const [button] = findAll(root, 'Button');
  if (!button) {
    throw new Error('create button was not rendered');
  }
  await act(async () => {
    (button.props as { onPress: () => void }).onPress();
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NewProfileScreen caller request', () => {
  beforeEach(() => {
    createMutate.mockReset();
    routerReplace.mockReset();
    routerBack.mockReset();
    routerCanGoBack.value = true;
    createMutate.mockResolvedValue({ id: 'profile-1' });
    boundaryState.organizationId = 'org-1';
    boundaryState.role = 'owner';
    boundaryState.org = { organizationName: 'First test organization' };
    boundaryState.isResolving = false;
  });

  it('starts on the owner its caller asked for and hands the form back on save', async () => {
    const { renderer, unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
    });

    expect(findAll(renderer.root, 'SegmentedControl')[0]?.props.value).toBe('organization');

    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({
      name: 'Org profile',
      organizationId: 'org-1',
    });
    expect(routerBack).toHaveBeenCalledOnce();
    expect(routerReplace).not.toHaveBeenCalled();

    unmount();
  });

  it('opens the new profile when the caller has no screen to return to', async () => {
    routerCanGoBack.value = false;
    const { renderer, unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
    });

    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1?org=org-1');

    unmount();
  });

  it('keeps the overview when no caller asked for the form back', async () => {
    const { renderer, unmount } = await mount({ initialOwner: 'organization' });

    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1?org=org-1');

    unmount();
  });

  it('resolves its organization from the caller, not the active account', async () => {
    boundaryArgs.value = [];
    const { unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
      organizationId: 'org-2',
    });

    expect(boundaryArgs.value).toContain('org-2');

    unmount();
  });

  it('a member asked for organization ownership still only creates a personal profile', async () => {
    boundaryState.role = 'member';
    const { renderer, unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
    });

    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });

    unmount();
  });
});
