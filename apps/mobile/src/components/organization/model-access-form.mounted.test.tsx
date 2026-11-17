// The save contract of the providers-and-models form. An organization with no
// saved provider allow list allows every provider, including BYOK-only ones the
// mobile catalog cannot name, so a save that only touched the Models tab must
// omit that list (`updateAllowLists` reads an omitted list as unchanged). An
// edit on the Providers tab writes it, and an empty list is refused because it
// blocks every Kilo route.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';

import '@/i18n';
import { ModelAccessForm } from './model-access-form';
import {
  type CatalogModel,
  type ModelAccessDraft,
  setProvidersAllowed,
  toggleModel,
  toggleProvider,
} from '@/lib/organization/model-access';

const saved = vi.hoisted(() => ({ mutateAsync: vi.fn<(input: unknown) => Promise<void>>() }));

vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useSaveOrgModelAccess: () => ({ mutateAsync: saved.mutateAsync, isPending: false }),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Button', props, props.children as never),
  };
});
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', async () => {
  const { createElement: h } = await import('react');
  return {
    Text: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Text', props, props.children as never),
  };
});
vi.mock('@/components/organization/model-access-lists', () => ({
  ModelDenyList: 'ModelDenyList',
  ProviderAllowList: 'ProviderAllowList',
}));
vi.mock('@/components/organization/providers-gateways-section', () => ({
  GatewaySettingsSection: 'GatewaySettingsSection',
}));

function model(id: string, providers: readonly string[]): CatalogModel {
  return { id, name: id, inference_provider_ids: [...providers] } satisfies CatalogModel;
}

const CATALOG = [model('anthropic/claude', ['anthropic']), model('openai/gpt', ['openai'])];

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(providerAllowList: readonly string[] | undefined) {
  saved.mutateAsync.mockResolvedValue(undefined);
  act(() => {
    renderer = TestRenderer.create(
      createElement(ModelAccessForm, {
        organizationId: 'org-1',
        canEdit: true,
        models: [],
        catalog: CATALOG,
        providerAllowList,
        modelDenyList: [],
        gateway: undefined,
        gatewayIsError: false,
        gatewayIsFetching: false,
        onRetryGateway: () => undefined,
      })
    );
  });
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  return renderer.root;
}

function list(root: ReactTestInstance, type: 'ModelDenyList' | 'ProviderAllowList') {
  return root.findByType(type as never);
}

function selectTab(root: ReactTestInstance, tab: 'models' | 'providers') {
  act(() => {
    (root.findByType('SegmentedControl' as never).props.onChange as (next: string) => void)(tab);
  });
}

function changeDraft(root: ReactTestInstance, next: ModelAccessDraft) {
  act(() => {
    (root.findByType('ModelDenyList' as never).props.onChange as (draft: ModelAccessDraft) => void)(
      next
    );
  });
}

async function pressSave(root: ReactTestInstance) {
  const buttons = root.findAllByType('Button' as never);
  const save = buttons[1];
  if (!save) {
    throw new Error('save button not found');
  }
  expect(buttons).toHaveLength(2);
  await act(async () => {
    (save.props.onPress as () => void)();
    await Promise.resolve();
  });
  return save;
}

function statusMessage(root: ReactTestInstance): unknown {
  return root.findByType('AccessibleStatus' as never).props.message;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  saved.mutateAsync.mockReset();
});

describe('ModelAccessForm save', () => {
  it('omits provider_allow_list when an absent list was not edited', async () => {
    const root = render(undefined);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    await pressSave(root);

    expect(saved.mutateAsync).toHaveBeenCalledTimes(1);
    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: ['openai/gpt'],
    });
  });

  it('writes the whole list once the Providers tab changed', async () => {
    const root = render(undefined);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    selectTab(root, 'providers');
    const providersDraft = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    act(() => {
      (list(root, 'ProviderAllowList').props.onChange as (next: ModelAccessDraft) => void)(
        toggleProvider(providersDraft, 'openai', false)
      );
    });
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      provider_allow_list: ['anthropic'],
      model_deny_list: ['openai/gpt'],
    });
  });

  it('always writes a list the organization already saved', async () => {
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      provider_allow_list: ['anthropic'],
      model_deny_list: ['openai/gpt'],
    });
  });

  it('refuses an empty list that would block every route', async () => {
    const root = render(undefined);
    selectTab(root, 'providers');
    const providersDraft = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    act(() => {
      (list(root, 'ProviderAllowList').props.onChange as (next: ModelAccessDraft) => void)(
        setProvidersAllowed(providersDraft, providersDraft.providerAllowList, false)
      );
    });

    const save = await pressSave(root);

    expect(save.props.disabled).toBe(true);
    expect(saved.mutateAsync).not.toHaveBeenCalled();
    expect(String(statusMessage(root))).toContain('Allow at least one provider');
  });
});
