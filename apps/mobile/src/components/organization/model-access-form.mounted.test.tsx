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
  setModelsAllowed,
  setProvidersAllowed,
  toggleModel,
  toggleProvider,
} from '@/lib/organization/model-access';

const saved = vi.hoisted(() => ({ mutateAsync: vi.fn<(input: unknown) => Promise<void>>() }));

vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useSaveOrgModelAccess: () => ({ mutateAsync: saved.mutateAsync, isPending: false }),
}));
// The form hands the lapsed-plan state to the shared refusal, which owns the
// mark, the tint and the ink: the primitive's own suite proves its paint, so
// this harness only needs the host node.
vi.mock('@/components/organization/plan-refusal', () => ({
  OrganizationPlanRefusal: 'OrganizationPlanRefusal',
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

/** The catalog plus a model no saved deny list names, so an edit stays valid. */
const WIDE_CATALOG = [...CATALOG, model('google/gemini', ['google'])];

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

type Overrides = {
  catalogUnavailable?: boolean;
  onRetryCatalog?: () => void;
  modelDenyList?: readonly string[];
  catalog?: readonly CatalogModel[];
  planEnded?: boolean;
};

function element(providerAllowList: readonly string[] | undefined, overrides: Overrides = {}) {
  return createElement(ModelAccessForm, {
    organizationId: 'org-1',
    canEdit: true,
    planEnded: overrides.planEnded ?? false,
    models: [],
    catalog: overrides.catalogUnavailable === true ? [] : (overrides.catalog ?? CATALOG),
    catalogUnavailable: overrides.catalogUnavailable === true,
    catalogIsFetching: false,
    onRetryCatalog: overrides.onRetryCatalog ?? (() => undefined),
    providerAllowList,
    modelDenyList: overrides.modelDenyList ?? [],
    gateway: undefined,
    gatewayIsError: false,
    gatewayIsFetching: false,
    onRetryGateway: () => undefined,
  });
}

function render(providerAllowList: readonly string[] | undefined, overrides: Overrides = {}) {
  saved.mutateAsync.mockResolvedValue(undefined);
  act(() => {
    renderer = TestRenderer.create(element(providerAllowList, overrides));
  });
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  return renderer.root;
}

/** Render the same form again with the catalog now loaded. */
function renderWithCatalog(
  providerAllowList: readonly string[] | undefined,
  overrides: Overrides = {}
) {
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  act(() => {
    renderer?.update(element(providerAllowList, overrides));
  });
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
  const save = buttons.at(-1);
  if (!save) {
    throw new Error('save button not found');
  }
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

  it('refuses two taps that would deny every model', async () => {
    const root = render(undefined);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, setModelsAllowed(draft, ['anthropic/claude', 'openai/gpt'], false));

    const save = await pressSave(root);

    expect(save.props.disabled).toBe(true);
    expect(saved.mutateAsync).not.toHaveBeenCalled();
    expect(String(statusMessage(root))).toContain('Leave at least one model on');
  });
});

describe('ModelAccessForm without the catalog', () => {
  it('keeps the saved lists editable and offers a retry instead of a full-screen error', async () => {
    const onRetryCatalog = vi.fn<() => void>();
    const root = render(['anthropic'], { catalogUnavailable: true, onRetryCatalog });

    const copy = root
      .findAllByType('Text' as never)
      .map(node => node.props.children)
      .find(value => typeof value === 'string' && value.includes('full model catalog'));
    expect(copy).toBeDefined();
    expect(list(root, 'ModelDenyList').props.draft).toBeDefined();
    selectTab(root, 'providers');
    expect(list(root, 'ProviderAllowList').props.providers).toEqual(['anthropic']);

    const buttons = root.findAllByType('Button' as never);
    const retry = buttons[0];
    if (retry === undefined) {
      throw new Error('retry button missing');
    }
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(onRetryCatalog).toHaveBeenCalledTimes(1);
  });

  it('locks the Providers tab and saves no provider list while the catalog is unavailable', async () => {
    const root = render(undefined, { catalogUnavailable: true });

    selectTab(root, 'providers');
    expect(list(root, 'ProviderAllowList').props.disabled).toBe(true);
    const notice = root
      .findAllByType('Text' as never)
      .map(node => node.props.children)
      .find(value => typeof value === 'string' && value.includes('read-only until'));
    expect(notice).toBeDefined();

    selectTab(root, 'models');
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;
    changeDraft(root, toggleModel(draft, 'anthropic/claude', false));
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: ['anthropic/claude'],
    });
  });

  it('leaves a saved provider list alone while the catalog is unavailable', async () => {
    const root = render(['anthropic'], { catalogUnavailable: true });
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: ['openai/gpt'],
    });
  });

  it('rebases the provider rows on the whole catalog once it loads', async () => {
    render(undefined, { catalogUnavailable: true });
    const root = renderWithCatalog(undefined);

    selectTab(root, 'providers');
    const providers = root.findByType('ProviderAllowList' as never);
    expect(providers.props.providers).toEqual(['anthropic', 'openai']);
    expect(providers.props.disabled).toBe(false);

    act(() => {
      (providers.props.onChange as (draft: ModelAccessDraft) => void)(
        toggleProvider(providers.props.draft as ModelAccessDraft, 'openai', false)
      );
    });
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      provider_allow_list: ['anthropic'],
      model_deny_list: [],
    });
  });
});

describe('ModelAccessForm with both rebases in one render', () => {
  it('keeps the deny list a refetch brought when the catalog arrives with it', async () => {
    // The catalog can arrive in the same payload update as a newer saved deny
    // list, so both rebases land in one render.
    render(undefined, { catalogUnavailable: true, catalog: WIDE_CATALOG });
    const root = renderWithCatalog(undefined, {
      modelDenyList: ['openai/gpt'],
      catalog: WIDE_CATALOG,
    });

    selectTab(root, 'providers');
    const providerRowsShown = list(root, 'ProviderAllowList').props.providers;
    expect(providerRowsShown).toEqual(['anthropic', 'google', 'openai']);
    selectTab(root, 'models');
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;
    expect(draft.modelDenyList).toEqual(['openai/gpt']);

    // The form is clean on what the server answered, so save is off.
    const cleanSave = root.findAllByType('Button' as never).at(-1);
    expect(cleanSave?.props.disabled).toBe(true);

    // An edit writes the deny list the refetch brought, not the empty one the
    // form started from.
    changeDraft(root, toggleModel(draft, 'anthropic/claude', false));
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: ['anthropic/claude', 'openai/gpt'],
    });
  });
});
