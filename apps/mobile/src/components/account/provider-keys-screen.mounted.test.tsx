/* eslint-disable max-lines -- one suite covers the personal and organization scopes, the row controls and every list state, against one mocked data layer. */
import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ProviderKeysScreen } from './provider-keys-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Key = {
  id: string;
  provider_id: string;
  provider_name: string;
  is_enabled: boolean;
  management_source: string;
};

type MutationOptions = {
  kind?: string;
  onSuccess?: (
    result: { outcome: string; provider?: string; model?: string; detail?: string },
    input?: never
  ) => void;
  onError?: (error: unknown) => void;
};

const state = vi.hoisted(() => ({
  keys: [] as Key[],
  error: false,
  errorCause: null as unknown,
  role: 'owner' as string | undefined,
  confirm: vi.fn(),
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  push: vi.fn(),
  client: {
    invalidateQueries: vi.fn(),
    cancelQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
  },
}));

vi.mock('react-native', () => ({ View: 'View', useColorScheme: () => 'light' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.keys,
      isPending: false,
      isError: state.error,
      error: state.errorCause,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useMutation: (options: MutationOptions) => {
      state.mutations.push(options);
      return { mutate: state.mutate, isPending: false, variables: undefined };
    },
    useQueryClient: () => state.client,
  };
});
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    role: state.role,
    // The hook reads `org` from the same membership entry it reads the role
    // from, so a role is exactly what makes the organization resolve.
    org: state.role === undefined ? undefined : { organizationId: 'org_1', role: state.role },
    isResolving: false,
  }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm, dialog: null }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    byok: {
      list: { queryOptions: () => ({}), queryKey: () => [] },
      setEnabled: {
        mutationOptions: (options: MutationOptions) => ({ kind: 'setEnabled', ...options }),
      },
      testApiKey: { mutationOptions: (options: MutationOptions) => ({ kind: 'test', ...options }) },
      delete: { mutationOptions: (options: MutationOptions) => ({ kind: 'delete', ...options }) },
    },
  }),
}));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound', Plus: 'Plus' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));

const SWITCH = 'Switch' as ElementType;
const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount(organizationId?: string) {
  const view = await renderWithProviders(
    createElement(ProviderKeysScreen, organizationId === undefined ? {} : { organizationId })
  );
  renderer = view.renderer;
  return view.renderer.root;
}

function switchFor(root: ReactTestRenderer['root'], provider: string) {
  const found = root.findAll(
    node => Object.is(node.type, SWITCH) && String(node.props.accessibilityLabel).includes(provider)
  );
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one switch for ${provider}, found ${found.length}`);
  }
  return only;
}

/** Every `Text` in the row that holds this provider's switch, in render order. */
function textsInRow(root: ReactTestRenderer['root'], provider: string) {
  const row = switchFor(root, provider).parent;
  if (!row) {
    throw new Error(`the ${provider} switch has no row`);
  }
  return row.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

function button(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(
    node =>
      Object.is(node.type, BUTTON) &&
      node.findAll(child => child.props.children === label).length > 0
  );
  const [first] = found;
  if (!first) {
    throw new Error(`missing ${label} button`);
  }
  return first;
}

function lastConfirm() {
  const call = state.confirm.mock.calls.at(-1)?.[0] as
    | { title: string; onConfirm: () => void }
    | undefined;
  if (!call) {
    throw new Error('confirm was never asked');
  }
  return call;
}

/** The key-test mutation the screen registered, whichever order it landed in. */
function testMutation() {
  const found = state.mutations.find(mutation => mutation.kind === 'test');
  if (!found) {
    throw new Error('the test mutation was never created');
  }
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.keys = [
    {
      id: 'key-1',
      provider_id: 'anthropic',
      provider_name: 'Anthropic',
      is_enabled: true,
      management_source: 'user',
    },
    // A disabled key renders exactly like an enabled one: the switch carries the
    // state, so the row has no state line to go stale when the key is toggled.
    {
      id: 'key-2b',
      provider_id: 'groq',
      provider_name: 'Groq',
      is_enabled: false,
      management_source: 'user',
    },
  ];
  state.error = false;
  state.errorCause = null;
  state.role = 'owner';
  state.mutations = [];
  state.mutate.mockClear();
  state.confirm.mockClear();
  state.push.mockClear();
  vi.mocked(announcingToast.success).mockClear();
  vi.mocked(announcingToast.error).mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderKeysScreen', () => {
  it('shows a user key as its provider name with the switch carrying the state', async () => {
    const root = await mount();

    // A user row is its provider name and nothing else: no state line, so the
    // switch is the only place the enabled/disabled state is read from.
    expect(textsInRow(root, 'Groq')).toEqual(['Groq']);
    expect(switchFor(root, 'Groq').props.value).toBe(false);
    expect(textsInRow(root, 'Anthropic')).toEqual(['Anthropic']);
    expect(switchFor(root, 'Anthropic').props.value).toBe(true);
  });

  it('sends the new value when a key is switched off', async () => {
    const root = await mount();

    act(() => {
      (switchFor(root, 'Anthropic').props.onValueChange as (value: boolean) => void)(false);
    });

    expect(state.mutate).toHaveBeenCalledWith({ id: 'key-1', is_enabled: false });
  });

  it('tests a key through the server', async () => {
    const root = await mount();

    act(() => {
      (button(root, 'Test key').props.onPress as () => void)();
    });

    expect(state.mutate).toHaveBeenCalledWith({ id: 'key-1' });
  });

  it('reports the key test verdict in its own words', async () => {
    await mount();

    act(() => {
      testMutation().onSuccess?.({ outcome: 'rejected' });
    });

    expect(announcingToast.error).toHaveBeenCalledWith(
      'The provider rejected this key. Check that it is correct and has not been revoked.'
    );
    expect(announcingToast.success).not.toHaveBeenCalled();

    act(() => {
      testMutation().onSuccess?.({
        outcome: 'ok',
        provider: 'Anthropic',
        model: 'claude-sonnet-4',
      });
    });

    expect(announcingToast.success).toHaveBeenCalledWith(
      'Key works. Provider: Anthropic. Model: claude-sonnet-4.'
    );
  });

  it('reports a failed test request in the same words', async () => {
    await mount();

    act(() => {
      testMutation().onError?.(new Error('socket hang up'));
    });

    expect(announcingToast.error).toHaveBeenCalledWith('The key test failed. Try again.');
  });

  it.each([
    ['incomplete', 'The provider ended the test before it finished. Try again.'],
    ['unsupported-provider', 'This provider is no longer supported. Remove the key.'],
    ['unreadable-key', 'The stored key could not be read. Try again later.'],
    ['deprecated-provider', 'This provider is deprecated, so its key cannot be tested.'],
  ])('names the %s verdict in its own words', async (outcome, copy) => {
    await mount();

    act(() => {
      testMutation().onSuccess?.({ outcome });
    });

    expect(announcingToast.error).toHaveBeenCalledWith(copy);
    expect(announcingToast.success).not.toHaveBeenCalled();
  });

  it('answers a tap whose outcome this build does not know', async () => {
    await mount();

    act(() => {
      testMutation().onSuccess?.({ outcome: 'rate-limited' });
    });

    expect(announcingToast.error).toHaveBeenCalledWith('The key test failed. Try again.');
    expect(announcingToast.success).not.toHaveBeenCalled();
  });

  it('asks before removing a key and then deletes it', async () => {
    const root = await mount();

    act(() => {
      (button(root, 'Remove').props.onPress as () => void)();
    });

    expect(lastConfirm().title).toBe('Remove the Anthropic key?');
    expect(state.mutate).not.toHaveBeenCalled();

    act(() => {
      lastConfirm().onConfirm();
    });
    expect(state.mutate).toHaveBeenCalledWith({ id: 'key-1' });
  });

  it('closes every control on a key the coding plan manages', async () => {
    state.keys = [
      {
        id: 'key-2',
        provider_id: 'openai',
        provider_name: 'OpenAI',
        is_enabled: true,
        management_source: 'coding_plan',
      },
    ];
    const root = await mount();

    expect(switchFor(root, 'OpenAI').props.disabled).toBe(true);
    expect(button(root, 'Test key').props.disabled).toBe(true);
    const texts = root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => node.props.children);
    expect(texts).toContain('Managed by your coding plan');
  });

  it('points an empty account at the add form', async () => {
    state.keys = [];
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['No provider keys']);

    act(() => {
      (button(root, 'Add key').props.onPress as () => void)();
    });
    expect(state.push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/provider-key-add');
  });

  it('opens the form on the key it edits, ready to replace the value', async () => {
    const root = await mount();

    act(() => {
      (button(root, 'Edit key').props.onPress as () => void)();
    });

    expect(state.push).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/provider-key-new',
      params: { provider: 'anthropic', id: 'key-1' },
    });
  });

  it('sends the organization with every write when it shows an organization’s keys', async () => {
    const root = await mount('org_1');

    act(() => {
      (switchFor(root, 'Anthropic').props.onValueChange as (value: boolean) => void)(false);
    });
    act(() => {
      (button(root, 'Test key').props.onPress as () => void)();
    });
    act(() => {
      (button(root, 'Remove').props.onPress as () => void)();
    });
    act(() => {
      lastConfirm().onConfirm();
    });

    expect(state.mutate).toHaveBeenCalledWith({
      organizationId: 'org_1',
      id: 'key-1',
      is_enabled: false,
    });
    expect(state.mutate).toHaveBeenCalledWith({ organizationId: 'org_1', id: 'key-1' });
  });

  it('opens the organization’s add form with its scope', async () => {
    state.keys = [];
    const root = await mount('org_1');

    act(() => {
      (button(root, 'Add key').props.onPress as () => void)();
    });

    expect(state.push).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/provider-key-add',
      params: { org: 'org_1' },
    });
  });

  it('reads an organization’s keys without offering a member any write', async () => {
    state.role = 'member';
    const root = await mount('org_1');

    expect(switchFor(root, 'Anthropic').props.disabled).toBe(true);
    expect(button(root, 'Test key').props.disabled).toBe(true);
    expect(
      root.findAll(
        node =>
          Object.is(node.type, BUTTON) &&
          node.findAll(child => child.props.children === 'Add key').length > 0
      )
    ).toHaveLength(0);
    expect(
      root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children)
    ).toContain('Only an organization owner, admin, or billing manager can change its keys.');
  });

  it('leaves an organization it cannot resolve to the boundary', async () => {
    // A failed organization list leaves the role unknown, which is not a
    // membership refusal: the boundary reports the failure, retry included.
    state.role = undefined;
    const root = await mount('org_1');

    const [boundary] = root.findAll(node => Object.is(node.type, 'OrganizationBoundary'));
    expect(boundary?.props.organizationIdOverride).toBe('org_1');
    expect(boundary?.props.title).toBe('Provider keys');
    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(0);
  });

  it('offers a retry when the list failed for a reason that can change', async () => {
    state.error = true;
    state.errorCause = new Error('The network dropped the request');
    const root = await mount();

    const [queryError] = root.findAll(node => Object.is(node.type, 'QueryError'));
    if (!queryError) {
      throw new Error('missing the failure state');
    }
    expect(queryError.props.variant).toBe('server');
    expect(typeof queryError.props.onRetry).toBe('function');
  });

  it('offers no retry when the server refuses the list itself', async () => {
    state.error = true;
    state.errorCause = { data: { code: 'FORBIDDEN', message: 'Not a member' } };
    const root = await mount();

    const [queryError] = root.findAll(node => Object.is(node.type, 'QueryError'));
    if (!queryError) {
      throw new Error('missing the failure state');
    }
    expect(queryError.props.variant).toBe('permission');
    expect(queryError.props.onRetry).toBeUndefined();
  });
});
