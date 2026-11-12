import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ProfileEditScreen } from './profile-edit-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Links = { linkedinUrl: string | null; githubUrl: string | null };

type MutationOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

type ScreenState = {
  links: Links;
  error: boolean;
  mutations: MutationOptions[];
  mutate: Mock;
  back: Mock;
  toastError: Mock;
};

const state = vi.hoisted((): ScreenState => ({
  links: { linkedinUrl: null, githubUrl: null },
  error: false,
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  invalidate: vi.fn(),
  back: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: state.back }) }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.links,
      isPending: false,
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useQueryClient: () => ({ invalidateQueries: state.invalidate }),
    useMutation: (options: MutationOptions) => {
      state.mutations.push(options);
      return { mutate: state.mutate, isPending: false };
    },
  };
});
vi.mock('sonner-native', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getProfileLinks: { queryOptions: () => ({}), queryKey: () => [] },
      updateProfile: { mutationOptions: (options: MutationOptions) => options },
    },
  }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));

const FIELD = 'FormField' as ElementType;
const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ProfileEditScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function field(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(node => Object.is(node.type, FIELD) && node.props.label === label);
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one ${label} field, found ${found.length}`);
  }
  return only;
}

function saveButton(root: ReactTestRenderer['root']) {
  const found = root.findAll(
    node => Object.is(node.type, BUTTON) && node.props.className !== undefined
  );
  const last = found.at(-1);
  if (!last) {
    throw new Error('missing Save button');
  }
  return last;
}

function press(root: ReactTestRenderer['root']): void {
  act(() => {
    (saveButton(root).props.onPress as () => void)();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.links = { linkedinUrl: null, githubUrl: null };
  state.error = false;
  state.mutations = [];
  state.mutate.mockClear();
  state.invalidate.mockClear();
  state.back.mockClear();
  state.toastError.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProfileEditScreen', () => {
  it('fills the fields with the saved links', async () => {
    state.links = {
      linkedinUrl: 'https://www.linkedin.com/in/ada',
      githubUrl: 'https://github.com/ada',
    };
    const root = await mount();

    expect(field(root, 'LinkedIn URL').props.defaultValue).toBe('https://www.linkedin.com/in/ada');
    expect(field(root, 'GitHub URL').props.defaultValue).toBe('https://github.com/ada');
  });

  it('submits only the edited link and returns on success', async () => {
    const root = await mount();

    act(() => {
      (field(root, 'LinkedIn URL').props.onChangeText as (value: string) => void)(
        'https://www.linkedin.com/in/ada'
      );
    });
    press(root);

    expect(state.mutate).toHaveBeenCalledWith({ linkedin_url: 'https://www.linkedin.com/in/ada' });

    act(() => {
      state.mutations[0]?.onSuccess?.();
    });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: [] });
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('rejects a link that is not a URL without a round trip', async () => {
    const root = await mount();

    act(() => {
      (field(root, 'GitHub URL').props.onChangeText as (value: string) => void)('github.com/ada');
    });
    press(root);

    expect(state.mutate).not.toHaveBeenCalled();
    expect(field(root, 'GitHub URL').props.error).toBe(
      'Enter a URL that starts with http:// or https://'
    );
  });

  it('clears a link by submitting null', async () => {
    state.links = { linkedinUrl: null, githubUrl: 'https://github.com/ada' };
    const root = await mount();

    act(() => {
      (field(root, 'GitHub URL').props.onChangeText as (value: string) => void)('');
    });
    press(root);

    expect(state.mutate).toHaveBeenCalledWith({ github_url: null });
  });

  it('returns without a request when nothing changed', async () => {
    const root = await mount();

    press(root);

    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('shows the server message when a save is refused', async () => {
    const root = await mount();
    act(() => {
      (field(root, 'LinkedIn URL').props.onChangeText as (value: string) => void)(
        'https://www.linkedin.com/in/ada'
      );
    });
    press(root);

    act(() => {
      state.mutations[0]?.onError?.(new Error('Could not update profile'));
    });

    expect(state.toastError).toHaveBeenCalledWith('Could not update profile');
    expect(state.back).not.toHaveBeenCalled();
  });

  it('offers a retry when the saved links cannot be read', async () => {
    state.error = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });
});
