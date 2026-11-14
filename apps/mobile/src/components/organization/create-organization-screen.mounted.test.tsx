// Create-organization screen contract: an empty name is refused before any
// request, a valid one creates with `autoAddCreator`, the new organization
// becomes the selection and the stack-safe replace lands on its hub, a create
// whose screen was left only refreshes the list, a failed refresh reports the
// organization without moving the selection, a failure shows the server's copy,
// and the submit control stays disabled until a name is typed. The tRPC client
// is mocked so no request leaves the test.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { CreateOrganizationScreen } from './create-organization-screen';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';

// `vi.mock` factories are hoisted above the statements in this file, so the
// shared doubles live in `vi.hoisted` and the factories only read them.
const mocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
  replace: vi.fn(),
  setOrganizationId: vi.fn(),
  focused: { current: true },
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { organizations: { create: { mutate: mocks.createMutate } } },
  useTRPC: () => ({ organizations: { list: { queryKey: () => ['organizations.list'] } } }),
}));

vi.mock('@/lib/organization-context', () => ({ useOrganization: () => mocks }));

// The create completes outside the screen's lifetime, so the focus answer and
// the hub navigation are the doubles this file drives.
vi.mock('@/lib/navigation/route-focus', () => ({
  useRouteFocused: () => mocks.focused.current,
}));

vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: mocks.replace }),
}));

vi.mock('@/lib/server-error-copy', () => ({
  organizationErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'Failed'),
}));

vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'state-action' }));

vi.mock('@/components/screen-header', async () => {
  const { createElement: h } = await import('react');
  return { ScreenHeader: (props: { title?: string }) => h('ScreenHeader', props) };
});

vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

vi.mock('@/components/ui/input', async () => {
  const { createElement: h } = await import('react');
  return { Input: (props: Record<string, unknown>) => h('Input', props) };
});

vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Button', props, props.children as never),
  };
});

vi.mock('@/components/ui/text', async () => {
  const { createElement: h } = await import('react');
  return {
    Text: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Text', props, props.children as never),
  };
});

vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'ios' } }));

function mount() {
  return renderWithProviders(createElement(CreateOrganizationScreen));
}

type Handler = (value?: string) => void;

/**
 * The element's prop callback, narrowed out of the renderer's untyped props so
 * the call is checked rather than an unsafe `any` invocation.
 */
function handlerOf(node: ReactTestInstance, name: 'onPress' | 'onChangeText'): Handler | undefined {
  const handler: unknown = node.props[name];
  return typeof handler === 'function' ? (handler as Handler) : undefined;
}

function inputOf(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByType('Input');
}

function submitOf(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByType('Button');
}

function texts(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType('Text').flatMap(node => node.props.children);
}

async function type(renderer: ReactTestRenderer, value: string) {
  await act(() => {
    handlerOf(inputOf(renderer), 'onChangeText')?.(value);
  });
}

beforeEach(() => {
  mocks.createMutate.mockReset();
  mocks.replace.mockClear();
  mocks.setOrganizationId.mockClear();
  mocks.focused.current = true;
});

describe('CreateOrganizationScreen', () => {
  it('refuses an empty name without a request', async () => {
    const { renderer, unmount } = await mount();

    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });

    expect(mocks.createMutate).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain('Enter an organization name.');
    unmount();
  });

  it('keeps the submit control disabled until a name is typed', async () => {
    const { renderer, unmount } = await mount();

    expect(submitOf(renderer).props.disabled).toBe(true);
    await type(renderer, '  Acme  ');
    expect(submitOf(renderer).props.disabled).toBe(false);
    unmount();
  });

  it('refuses a name of only invisible characters without a request', async () => {
    const { renderer, unmount } = await mount();

    // `String.prototype.trim` keeps zero-width spaces, so the old gate called
    // this a name; the server's visible-character rule refuses it.
    await type(renderer, '\u200B\u200B\u200B');
    expect(submitOf(renderer).props.disabled).toBe(true);
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });

    expect(mocks.createMutate).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain('Enter an organization name.');
    unmount();
  });

  it('creates with the trimmed name, selects the new organization and lands on its hub', async () => {
    mocks.createMutate.mockResolvedValue({ organization: { id: 'org-new' } });
    const { renderer, queryClient, unmount } = await mount();
    // The refresh the completion waits for has to carry the membership, or the
    // selection would read as a lost membership.
    queryClient.setQueryData(['organizations.list'], [{ organizationId: 'org-new' }]);

    await type(renderer, '  Acme  ');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });

    expect(mocks.createMutate).toHaveBeenCalledWith({ name: 'Acme', autoAddCreator: true });
    expect(mocks.setOrganizationId).toHaveBeenCalledWith('org-new');
    expect(mocks.replace).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
    unmount();
  });

  it('keeps the submit control disabled while the completion runs', async () => {
    const pending = Promise.withResolvers<{ organization: { id: string } }>();
    mocks.createMutate.mockReturnValue(pending.promise);
    const { renderer, queryClient, unmount } = await mount();
    queryClient.setQueryData(['organizations.list'], [{ organizationId: 'org-new' }]);

    await type(renderer, 'Acme');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });
    expect(submitOf(renderer).props.disabled).toBe(true);

    await act(() => {
      pending.resolve({ organization: { id: 'org-new' } });
    });
    expect(submitOf(renderer).props.disabled).toBe(false);
    unmount();
  });

  it('leaves the selection alone when the screen lost focus before the create finished', async () => {
    const pending = Promise.withResolvers<{ organization: { id: string } }>();
    mocks.createMutate.mockReturnValue(pending.promise);
    const { renderer, queryClient, unmount } = await mount();
    queryClient.setQueryData(['organizations.list'], [{ organizationId: 'org-new' }]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await type(renderer, 'Acme');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });
    // A push covers the screen without unmounting it, so the create must not
    // move the selection of a screen the person is no longer looking at. In the
    // app the blur subscription re-renders the screen; the field edit here
    // gives the component that render, and the focus ref follows it.
    mocks.focused.current = false;
    await type(renderer, '  ');
    await act(() => {
      pending.resolve({ organization: { id: 'org-new' } });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations.list'] });
    expect(mocks.setOrganizationId).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    unmount();
  });

  it('only refreshes the list when the screen was left before the create finished', async () => {
    const pending = Promise.withResolvers<{ organization: { id: string } }>();
    mocks.createMutate.mockReturnValue(pending.promise);
    const { renderer, queryClient, unmount } = await mount();
    queryClient.setQueryData(['organizations.list'], [{ organizationId: 'org-new' }]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await type(renderer, 'Acme');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });
    unmount();
    await act(() => {
      pending.resolve({ organization: { id: 'org-new' } });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations.list'] });
    expect(mocks.setOrganizationId).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('keeps the selection when the refreshed list does not carry the new organization', async () => {
    mocks.createMutate.mockResolvedValue({ organization: { id: 'org-new' } });
    const { renderer, queryClient, unmount } = await mount();
    // The refetch behind the invalidation failed, so the list still holds the
    // memberships from before the create.
    queryClient.setQueryData(['organizations.list'], []);

    await type(renderer, 'Acme');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });

    expect(mocks.setOrganizationId).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain(
      'Organization created. It will appear in the picker shortly.'
    );
    unmount();
  });

  it('shows the server copy when the create fails', async () => {
    mocks.createMutate.mockRejectedValue(
      new Error('You already own the maximum number of organizations.')
    );
    const { renderer, unmount } = await mount();

    await type(renderer, 'Acme');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain('You already own the maximum number of organizations.');
    unmount();
  });
});
