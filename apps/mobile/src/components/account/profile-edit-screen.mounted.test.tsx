/* eslint-disable max-lines -- one suite covers every state, save outcome and exit of this screen, and each case drives the same react-native, expo-router and tRPC mock harness declared here. */
import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import '@/i18n';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
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
  invalidate: Mock;
  links: Links;
  linksPending: boolean;
  error: boolean;
  mutations: MutationOptions[];
  mutate: Mock;
  pending: boolean;
  back: Mock;
  focused: boolean;
  headerBack: (() => void) | undefined;
  toastError: Mock;
  toastSuccess: Mock;
};

const state = vi.hoisted((): ScreenState => ({
  links: { linkedinUrl: null, githubUrl: null },
  linksPending: false,
  error: false,
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  pending: false,
  invalidate: vi.fn(),
  back: vi.fn(),
  focused: true,
  headerBack: undefined,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  // Nothing dispatches a hardware Back in this harness, so the subscription only
  // has to answer the hook's cleanup.
  BackHandler: {
    addEventListener: () => ({
      remove: () => {
        // no listener was registered
      },
    }),
  },
}));
vi.mock('expo-router', () => {
  // Stable objects, like the real hooks: a new identity per render would re-run
  // the effects `usePopOnce` registers on them. The screen's own Back press asks
  // whether there is history to pop; this harness always has some.
  const router = { back: state.back, canGoBack: () => true };
  const navigation = {
    isFocused: () => state.focused,
    addListener: () => () => {
      // the mocked navigator never emits `blur`
    },
    // This route alone, with no scene below it: a dismissal names no reveal
    // scene and its window settles as it always did.
    getState: () => ({ index: 0, routes: [{ key: 'route-this' }] }),
    getParent: () => undefined,
  };
  return { useRouter: () => router, useNavigation: () => navigation };
});
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.links,
      isPending: state.linksPending,
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useQueryClient: () => ({ invalidateQueries: state.invalidate }),
    useMutation: (options: MutationOptions) => {
      state.mutations.push(options);
      return { mutate: state.mutate, isPending: state.pending };
    },
  };
});
vi.mock('sonner-native', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: state.toastSuccess, error: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getProfileLinks: { queryOptions: () => ({}), queryKey: () => [] },
      updateProfile: { mutationOptions: (options: MutationOptions) => options },
    },
  }),
}));
vi.mock('@/components/screen-header', () => ({
  // The real header runs its `onBack` for a Back press; keep that callback so a
  // test can deliver the press.
  ScreenHeader: (props: { onBack?: () => void }) => {
    state.headerBack = props.onBack;
    return 'ScreenHeader';
  },
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));

const FIELD = 'FormField' as ElementType;
const BUTTON = 'Button' as ElementType;
const TEXT = 'Text' as ElementType;

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

/** Type into the GitHub field, as a reader editing the link would. */
function typeGithub(root: ReactTestRenderer['root'], value: string): void {
  act(() => {
    (field(root, 'GitHub URL').props.onChangeText as (value: string) => void)(value);
  });
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

/**
 * The reader's Back on this screen's header. The real header dispatches through
 * `useHeaderBack`: a declared `onBack` is the handler, and without one it pops
 * with `router.back()` of its own. Both arms are reproduced here, so a screen
 * that leaves the header to pop by itself is measured, not excused.
 */
function pressHeaderBack(): void {
  const onBack = state.headerBack;
  act(() => {
    if (onBack) {
      onBack();
      return;
    }
    state.back();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetLeaveSettle();
  state.links = { linkedinUrl: null, githubUrl: null };
  state.linksPending = false;
  state.error = false;
  state.mutations = [];
  state.pending = false;
  state.focused = true;
  state.headerBack = undefined;
  state.mutate.mockClear();
  state.invalidate.mockClear();
  state.back.mockClear();
  state.toastError.mockClear();
  state.toastSuccess.mockClear();
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

  it('does not pop the screen beneath when the reader left before the save settled', async () => {
    const root = await mount();

    typeGithub(root, 'https://github.com/ada');
    press(root);
    expect(state.mutate).toHaveBeenCalledWith({ github_url: 'https://github.com/ada' });
    expect(state.back).not.toHaveBeenCalled();

    // The reader's Back reached the navigator, so this screen is already leaving.
    state.focused = false;
    act(() => {
      state.mutations.at(-1)?.onSuccess?.();
    });

    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: [] });
    expect(state.toastSuccess).toHaveBeenCalledWith('Profile updated');
    expect(state.back).not.toHaveBeenCalled();
  });

  it('pops once for a save, and never for a repeated settle or a no-change Save', async () => {
    const root = await mount();

    typeGithub(root, 'https://github.com/ada');
    press(root);
    act(() => {
      state.mutations.at(-1)?.onSuccess?.();
    });
    expect(state.back).toHaveBeenCalledTimes(1);

    act(() => {
      state.mutations.at(-1)?.onSuccess?.();
    });
    expect(state.back).toHaveBeenCalledTimes(1);

    // Back to the saved value: Save submits nothing, and must not pop either.
    act(() => {
      (field(root, 'GitHub URL').props.onChangeText as (value: string) => void)('');
    });
    press(root);

    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('leaves once when the save completes before the reader presses Back', async () => {
    const root = await mount();

    typeGithub(root, 'https://github.com/ada');
    press(root);

    // The mutation settles first: the completion pops the editor and opens the
    // leave window.
    act(() => {
      state.mutations.at(-1)?.onSuccess?.();
    });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: [] });
    expect(state.back).toHaveBeenCalledTimes(1);

    // The reader's Back still reaches this header during that pop, because the
    // header stays the touch owner until the transition ends.
    pressHeaderBack();

    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('leaves once when the header Back precedes the save completion', async () => {
    const root = await mount();

    typeGithub(root, 'https://github.com/ada');
    press(root);

    // The reader leaves through the header while the save is in flight.
    pressHeaderBack();
    expect(state.back).toHaveBeenCalledTimes(1);

    // The navigator applied that Back, so this route is no longer focused when
    // the save settles.
    state.focused = false;
    act(() => {
      state.mutations.at(-1)?.onSuccess?.();
    });

    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: [] });
    expect(state.toastSuccess).toHaveBeenCalledWith('Profile updated');
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

  it('states that an empty field deletes the link, and holds the error slot from the first render', async () => {
    const root = await mount();

    // An emptied field submits `null`, which deletes the saved link; the screen
    // says so before the reader clears anything.
    const hints = root.findAll(
      node =>
        Object.is(node.type, TEXT) &&
        node.props.children === 'Saving an empty field deletes that link'
    );
    expect(hints).toHaveLength(1);

    // The rule can arrive from a Save press with no focus on the field, so both
    // fields hold their error line from the first render: the Save button below
    // them never moves between the untouched form and a shown error.
    for (const label of ['LinkedIn URL', 'GitHub URL']) {
      const props = field(root, label).props as {
        alwaysReserve?: boolean;
        reserveErrorMessages?: string[];
      };
      expect(props.alwaysReserve).toBe(true);
      expect(props.reserveErrorMessages).toEqual([
        'Enter a URL that starts with http:// or https://',
      ]);
    }
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

  it('hides the empty-field hint when the retry is the whole body', async () => {
    state.error = true;
    const root = await mount();

    // The hint explains what an emptied field does; the error body has no
    // fields, so the rule is not shown beside a screen that cannot edit them.
    const hints = root.findAll(
      node =>
        Object.is(node.type, TEXT) &&
        node.props.children === 'Saving an empty field deletes that link'
    );
    expect(hints).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });

  it('reserves the message line in each field of the loading placeholder', async () => {
    state.linksPending = true;
    const root = await mount();

    // A loaded field holds its label line, its input box and the message line it
    // reserves from the first render. The placeholder must hold the same three,
    // or the swap to real content grows the body and moves the Save button.
    const fieldBlocks = root.findAll(
      node =>
        Object.is(node.type, 'View') &&
        typeof node.props.className === 'string' &&
        node.props.className === 'gap-1.5' &&
        node.findAll(child => Object.is(child.type, 'Skeleton')).length === 3
    );
    expect(fieldBlocks).toHaveLength(2);

    // The input bar must carry the loaded box's own geometry token, because a
    // hand-sized bar drifts from it (rem is 14pt, so `h-11` is 38.5pt against the
    // 44pt box). A block's second Skeleton is that bar: label, input, message.
    for (const block of fieldBlocks) {
      const [, inputBar] = block.findAll(child => Object.is(child.type, 'Skeleton'));
      expect(inputBar).toBeDefined();
      const tokens = String(inputBar?.props.className).split(' ');
      expect(tokens).toEqual(expect.arrayContaining(INPUT_BOX_SHAPE_CLASS.split(' ')));
    }

    // The Save slot is the loaded button's own frame, and no placeholder bar is
    // hand-sized.
    const allSkeletonClasses = root
      .findAll(node => Object.is(node.type, 'Skeleton'))
      .map(node => String(node.props.className));
    const actionTokens = STATE_ACTION_CLASS.split(' ');
    const actionBars = allSkeletonClasses.filter(classes => {
      const tokens = classes.split(' ');
      return actionTokens.every(token => tokens.includes(token));
    });
    expect(actionBars).toHaveLength(1);
    const handSized = allSkeletonClasses.filter(classes => classes.split(' ').includes('h-11'));
    expect(handSized).toHaveLength(0);

    // The bar's height comes from this copy, so wrapping in a long locale cannot
    // make the loaded form taller than the placeholder.
    const placeholderCopy = root
      .findAll(node => Object.is(node.type, TEXT))
      .map(node => node.props.children);
    expect(placeholderCopy.filter(copy => copy === 'LinkedIn URL')).toHaveLength(1);
    expect(placeholderCopy.filter(copy => copy === 'GitHub URL')).toHaveLength(1);
    expect(
      placeholderCopy.filter(copy => copy === 'Enter a URL that starts with http:// or https://')
    ).toHaveLength(2);
  });

  it('keeps the fields live and takes one save while a save is pending', async () => {
    state.links = { linkedinUrl: 'https://www.linkedin.com/in/ada', githubUrl: null };
    state.pending = true;
    const root = await mount();

    // The pending repaint of an Android text input publishes a text state built
    // from `defaultValue`, the link last saved, so the fields never take the
    // pending disable: they would show the old link instead of the one being sent.
    expect(field(root, 'LinkedIn URL').props.disabled).toBeUndefined();
    expect(field(root, 'GitHub URL').props.disabled).toBeUndefined();
    expect(saveButton(root).props.loading).toBe(true);

    // This render already reads the save as pending, so the guard refuses the press.
    typeGithub(root, 'https://github.com/ada');
    press(root);

    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('saves once when Save is pressed twice before the button shows the save as pending', async () => {
    const root = await mount();

    // `state.pending` stays false for the whole case: the pending render never
    // commits, so both presses run the handler that still reads `isPending` as
    // false, exactly as on the device when the second tap arrives first.
    typeGithub(root, 'https://github.com/ada');
    press(root);
    press(root);

    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate).toHaveBeenCalledWith({ github_url: 'https://github.com/ada' });
  });
});
