// Create-organization screen contract: an empty name is refused before any
// request, a valid one creates with `autoAddCreator`, the new organization
// becomes the selection and the router lands on its hub, a failure shows the
// server's copy, and the submit control stays disabled until a name is typed.
// The tRPC client is mocked so no request leaves the test.

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
  push: vi.fn(),
  setOrganizationId: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: mocks.replace, push: mocks.push }) }));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { organizations: { create: { mutate: mocks.createMutate } } },
  useTRPC: () => ({ organizations: { list: { queryKey: () => ['organizations.list'] } } }),
}));

vi.mock('@/lib/organization-context', () => ({ useOrganization: () => mocks }));

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
  mocks.push.mockClear();
  mocks.setOrganizationId.mockClear();
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

  it('creates with the trimmed name, selects the new organization and lands on its hub', async () => {
    mocks.createMutate.mockResolvedValue({ organization: { id: 'org-new' } });
    const { renderer, unmount } = await mount();

    await type(renderer, '  Acme  ');
    await act(() => {
      handlerOf(submitOf(renderer), 'onPress')?.();
    });

    expect(mocks.createMutate).toHaveBeenCalledWith({ name: 'Acme', autoAddCreator: true });
    expect(mocks.setOrganizationId).toHaveBeenCalledWith('org-new');
    expect(mocks.replace).toHaveBeenCalledWith(ORGANIZATION_HUB_PATH);
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
