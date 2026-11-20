/* eslint-disable max-lines -- one mounted suite covers the save contract, the refusal copy and the two-tab draft rules of one form. */
// The save contract of the providers-and-models form. An organization with no
// saved provider allow list allows every provider, including BYOK-only ones the
// mobile catalog cannot name, so a save that only touched the Models tab must
// omit that list (`updateAllowLists` reads an omitted list as unchanged). An
// edit on the Providers tab writes it, and an empty list is refused because it
// blocks every Kilo route.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { ModelAccessForm } from './model-access-form';
import {
  type CatalogModel,
  type ModelAccessDraft,
  setModelsAllowed,
  setProvidersAllowed,
  toggleModel,
  toggleProvider,
} from '@/lib/organization/model-access';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

const saved = vi.hoisted(() => ({ mutateAsync: vi.fn<(input: unknown) => Promise<void>>() }));

/**
 * What the durable draft answers. Both states carry `save`/`clear`: the real
 * hook writes through while it still reports `loading`, before the identity or
 * the store has answered.
 */
const draftStore = vi.hoisted(() => ({
  kind: 'loading' as 'loading' | 'ready',
  value: null as unknown,
  save: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useSaveOrgModelAccess: () => ({ mutateAsync: saved.mutateAsync, isPending: false }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1', isLoading: false }),
}));
// The durable draft is the account-scoped encrypted store, which mounts its own
// providers; this suite drives the form's use of it, not the store.
vi.mock('@/lib/persist/use-form-draft', () => ({
  useFormDraft: () =>
    draftStore.kind === 'ready'
      ? {
          kind: 'ready',
          value: draftStore.value,
          save: draftStore.save,
          clear: draftStore.clear,
        }
      : { kind: 'loading', save: draftStore.save, clear: draftStore.clear },
}));
// The real module opens the encrypted SQLCipher store, which this Node project
// cannot import; the form reads only its key helper.
vi.mock('@/lib/persist/drafts', () => ({
  orgModelAccessFormDraftKey: (organizationId: string) => `org-model-access-form:${organizationId}`,
}));
// The screen hands the form the reader's role; this harness passes the money
// role, because this suite's subject is the refusal copy a billing role reads
// and no billing step is rendered here.

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
// The form's leave guard needs a navigator; this suite asserts the save
// contract, the refusal copy and the draft rules, so it stubs the guard and
// ignores the `isDirty` derivation the stub takes no part in.
vi.mock('@/components/profiles/use-metadata-leave-guard', () => ({
  useMetadataLeaveGuard: () => ({
    handleDirtyChange: vi.fn(),
    leaveWithoutAsking: vi.fn(),
    dialog: null,
  }),
}));

function model(id: string, providers: readonly string[]): CatalogModel {
  return { id, name: id, inference_provider_ids: [...providers] } satisfies CatalogModel;
}

const CATALOG = [model('anthropic/claude', ['anthropic']), model('openai/gpt', ['openai'])];

/** The catalog plus a model no saved deny list names, so an edit stays valid. */
const WIDE_CATALOG = [...CATALOG, model('google/gemini', ['google'])];

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function element(
  providerAllowList: readonly string[] | undefined,
  overrides: {
    catalogUnavailable?: boolean;
    catalogIsFetching?: boolean;
    onRetryCatalog?: () => void;
    modelDenyList?: readonly string[];
    catalog?: readonly CatalogModel[];
  } = {}
) {
  return createElement(ModelAccessForm, {
    organizationId: 'org-1',
    canEdit: true,
    canManageBilling: true,
    models: [],
    catalog: overrides.catalogUnavailable === true ? [] : (overrides.catalog ?? CATALOG),
    catalogUnavailable: overrides.catalogUnavailable === true,
    catalogIsFetching: overrides.catalogIsFetching ?? false,
    onRetryCatalog: overrides.onRetryCatalog ?? (() => undefined),
    providerAllowList,
    modelDenyList: overrides.modelDenyList ?? [],
    gateway: undefined,
    gatewayIsError: false,
    gatewayIsFetching: false,
    onRetryGateway: () => undefined,
  });
}

function render(
  providerAllowList: readonly string[] | undefined,
  overrides: {
    catalogUnavailable?: boolean;
    catalogIsFetching?: boolean;
    onRetryCatalog?: () => void;
    modelDenyList?: readonly string[];
    catalog?: readonly CatalogModel[];
  } = {}
) {
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
  overrides: {
    catalogUnavailable?: boolean;
    modelDenyList?: readonly string[];
    catalog?: readonly CatalogModel[];
  } = {}
) {
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  act(() => {
    renderer?.update(element(providerAllowList, overrides));
  });
  return renderer.root;
}

/** Re-render the same form, so a mocked draft load can land after mount. */
function rerender(providerAllowList: readonly string[] | undefined) {
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  act(() => {
    renderer?.update(element(providerAllowList));
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

function changeProviders(root: ReactTestInstance, next: ModelAccessDraft) {
  act(() => {
    (
      root.findByType('ProviderAllowList' as never).props.onChange as (
        draft: ModelAccessDraft
      ) => void
    )(next);
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

/** The Cancel action: the outline button the form draws beside Save. */
function pressCancel(root: ReactTestInstance) {
  const cancel = root
    .findAllByType('Button' as never)
    .find(node => node.props.variant === 'outline');
  if (!cancel) {
    throw new Error('cancel button not found');
  }
  act(() => {
    (cancel.props.onPress as () => void)();
  });
}

function statusMessage(root: ReactTestInstance): unknown {
  return root.findByType('AccessibleStatus' as never).props.message;
}

/** The one button that carries `label`, so a state's way out is unambiguous. */
function buttonWithLabel(root: ReactTestInstance, label: string) {
  const button = root
    .findAllByType('Button' as never)
    .find(node =>
      node.findAllByType('Text' as never).some(child => child.props.children === label)
    );
  if (button === undefined) {
    throw new Error(`button ${label} missing`);
  }
  return button;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  saved.mutateAsync.mockReset();
  draftStore.kind = 'loading';
  draftStore.value = null;
  draftStore.save.mockReset();
  draftStore.clear.mockReset();
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
    // A saved slug is what gives the locked tab a row to hold: without the
    // catalog and without a saved list the tab has no rows at all, so it renders
    // no list at all.
    const root = render(['anthropic'], { catalogUnavailable: true });

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

describe('ModelAccessForm save copy', () => {
  it('shows the localized trial-ended line for the lapsed-plan refusal', async () => {
    const root = render(undefined);
    saved.mutateAsync.mockRejectedValue(
      Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
        data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE },
      })
    );
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, setModelsAllowed(draft, ['anthropic/claude'], true));
    await pressSave(root);

    // The form renders no billing step beside the failure line, so even the
    // role that can change the plan reads the sentence that names the
    // destination instead of one that claims an owner must act.
    expect(String(statusMessage(root))).toBe(
      i18n.t('common.organizationTrialEndedBillingAtKiloAi')
    );
  });

  it('falls back to the status-failed line for an unrecognized refusal', async () => {
    const root = render(undefined);
    saved.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Failed to update allow lists'), {
        data: { code: 'PATCH_FAILED', message: 'Failed to update allow lists' },
      })
    );
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, setModelsAllowed(draft, ['anthropic/claude'], true));
    await pressSave(root);

    expect(String(statusMessage(root))).toBe(i18n.t('organizationGuardrails.statusFailed'));
  });
});

describe('ModelAccessForm with no provider rows', () => {
  // The rows come from the gateway catalog plus the saved list, so an empty row
  // set means that data has not arrived. The screen must say so at the top and
  // offer the catalog retry, and the Providers tab must not render a list whose
  // only row would read as an organization policy that allows no provider.
  it('offers the catalog retry at the top and no empty provider list', async () => {
    const onRetryCatalog = vi.fn<() => void>();
    const root = render(undefined, { catalog: [], onRetryCatalog });

    // The notice is screen-level, so it is on the default tab already. It reads
    // as body text on the warning tile, not as a muted caption.
    const noticeText = root
      .findAllByType('Text' as never)
      .find(node => node.props.children === i18n.t('organizationModelAccess.providersUnavailable'));
    expect(noticeText?.props.variant).not.toBe('caption');
    expect(noticeText?.props.className).toContain('text-foreground');
    const noticeTile = root
      .findAllByType('View' as never)
      .find(node => String(node.props.className).includes('bg-warn-tile-bg'));
    expect(noticeTile?.props.className).toContain('border-warn-tile-border');

    selectTab(root, 'providers');
    expect(root.findAllByType('ProviderAllowList' as never)).toHaveLength(0);

    const retry = buttonWithLabel(root, i18n.t('common.retry'));
    expect(retry.props.loading).toBe(false);
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(onRetryCatalog).toHaveBeenCalledTimes(1);
  });

  it('saves no provider list when the row set empties under an edited draft', async () => {
    // The gateway's provider data disappears after an edit: the baseline rebases
    // to the empty rows while the draft keeps the providers the admin saw, so
    // the next save must leave the stored allow list alone.
    const root = render(undefined);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;
    changeDraft(root, toggleModel(draft, 'openai/gpt', false));

    renderWithCatalog(undefined, {
      catalog: [model('openai/gpt', []), model('anthropic/claude', [])],
    });

    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: ['openai/gpt'],
    });
  });

  it('rebases the provider list when the rows arrive under an edited draft', async () => {
    // The draft started while the gateway named no provider. The rows arrive
    // with a model edit in flight: the provider list must rebase to the catalog,
    // or Save stays blocked and the first toggle writes a narrow list.
    const root = render(undefined, {
      catalog: [model('openai/gpt', []), model('anthropic/claude', [])],
    });
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;
    changeDraft(root, toggleModel(draft, 'openai/gpt', false));

    renderWithCatalog(undefined, { catalog: CATALOG });
    selectTab(root, 'providers');
    expect(list(root, 'ProviderAllowList').props.providers).toEqual(['anthropic', 'openai']);
    selectTab(root, 'models');

    await pressSave(root);

    expect(saved.mutateAsync).toHaveBeenCalledTimes(1);
    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: ['openai/gpt'],
    });
  });

  it('keeps a provider toggle made while the rows were complete', async () => {
    // The admin turns a provider off, the gateway's provider data disappears,
    // and it comes back: the toggle was made against the whole catalog, so the
    // arrival rebase must not discard it.
    const root = render(undefined);
    selectTab(root, 'providers');
    const draft = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    (list(root, 'ProviderAllowList').props.onChange as (next: ModelAccessDraft) => void)(
      toggleProvider(draft, 'openai', false)
    );
    selectTab(root, 'models');

    renderWithCatalog(undefined, {
      catalog: [model('openai/gpt', []), model('anthropic/claude', [])],
    });
    renderWithCatalog(undefined, { catalog: CATALOG });

    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      provider_allow_list: ['anthropic'],
      model_deny_list: [],
    });
  });

  it('takes the arriving catalog after a reverted provider toggle', () => {
    // A switch turned off and back on leaves no choice behind, so a later row
    // gap must not keep the pre-gap list against the arriving catalog.
    const root = render(undefined);
    selectTab(root, 'providers');
    const start = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    changeProviders(root, toggleProvider(start, 'openai', false));
    const off = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    expect(off.providerAllowList).toEqual(['anthropic']);
    changeProviders(root, toggleProvider(off, 'openai', true));
    const reverted = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    expect(reverted.providerAllowList).toEqual(['anthropic', 'openai']);
    selectTab(root, 'models');
    // A model edit keeps the form dirty, so the draft itself survives the gap.
    changeDraft(root, toggleModel(reverted, 'anthropic/claude', false));

    renderWithCatalog(undefined, {
      catalog: [model('openai/gpt', []), model('anthropic/claude', [])],
    });
    renderWithCatalog(undefined, { catalog: WIDE_CATALOG });

    selectTab(root, 'providers');
    const arrived = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;

    expect(arrived.providerAllowList).toEqual(['anthropic', 'google', 'openai']);
  });

  it('shows the retry as loading while the catalog request runs', () => {
    const root = render(undefined, { catalog: [], catalogIsFetching: true });

    expect(buttonWithLabel(root, i18n.t('common.retry')).props.loading).toBe(true);
  });

  it('keeps a saved provider row the catalog does not name', () => {
    const root = render(['anthropic'], { catalog: [] });

    selectTab(root, 'providers');

    expect(list(root, 'ProviderAllowList').props.providers).toEqual(['anthropic']);
    // A saved slug is the only row and covers no provider the catalog left out,
    // so the tab says the provider list did not load instead of passing the row
    // off as the whole universe.
    expect(root.findAllByType('Text' as never).map(node => node.props.children)).toContain(
      i18n.t('organizationModelAccess.providersUnavailable')
    );
  });
});

describe('ModelAccessForm with a catalog that names no provider', () => {
  // The catalog's own provider slugs are the phone's only provider evidence. A
  // saved slug gives the tab a row to hold, but it says nothing about the
  // providers a policy filter dropped, so the rows are not the whole universe:
  // the tab stays read-only and a save leaves the stored list alone.
  const UNNAMED = [model('anthropic/claude', []), model('openai/gpt', [])];

  it('keeps the saved rows visible and locked until the catalog names providers', () => {
    const root = render(['anthropic', 'openai'], { catalog: UNNAMED });

    selectTab(root, 'providers');
    expect(list(root, 'ProviderAllowList').props.providers).toEqual(['anthropic', 'openai']);
    expect(list(root, 'ProviderAllowList').props.disabled).toBe(true);
    expect(root.findAllByType('Text' as never).map(node => node.props.children)).toContain(
      i18n.t('organizationModelAccess.providersNeedCatalog')
    );
    // The caption sends the reader to the retry above, so the notice tile that
    // carries the Retry button shows here even though the saved list gave the
    // tab rows.
    expect(root.findAllByType('Text' as never).map(node => node.props.children)).toContain(
      i18n.t('organizationModelAccess.providersUnavailable')
    );
  });

  it('writes no provider list from a provider toggle made on those rows', async () => {
    const root = render(['anthropic', 'openai'], { catalog: UNNAMED });

    selectTab(root, 'providers');
    const draft = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    changeProviders(root, toggleProvider(draft, 'openai', false));
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      model_deny_list: [],
    });
  });
});

describe('ModelAccessForm with a catalog that names every provider', () => {
  it('keeps a provider saved off as a row with its switch off, and allows it again', async () => {
    // The finding's own promise: the catalog names the provider, so turning it
    // off writes the list without it while the row stays, switched off, and the
    // same row turns it back on.
    const root = render(['anthropic', 'openai']);

    selectTab(root, 'providers');
    const start = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    changeProviders(root, toggleProvider(start, 'openai', false));
    await pressSave(root);

    // The form rebases on the saved policy, and the row the provider lost is
    // still there: rows come from the catalog plus the saved list. A row's
    // switch reads the draft, so the row listed without `openai` is the switch
    // drawn off.
    expect(list(root, 'ProviderAllowList').props.providers).toEqual(['anthropic', 'openai']);
    const off = list(root, 'ProviderAllowList').props.draft as ModelAccessDraft;
    expect(off.providerAllowList).toEqual(['anthropic']);

    changeProviders(root, toggleProvider(off, 'openai', true));
    await pressSave(root);

    expect(saved.mutateAsync.mock.calls.at(-1)?.[0]).toEqual({
      organizationId: 'org-1',
      provider_allow_list: ['anthropic', 'openai'],
      model_deny_list: [],
    });
  });
});

describe('ModelAccessForm durable draft', () => {
  it('seeds an untouched form from the stored draft', () => {
    const stored = { providerAllowList: ['openai'], modelDenyList: ['anthropic/claude'] };
    draftStore.kind = 'ready';
    draftStore.value = stored;

    const root = render(['anthropic']);

    expect(list(root, 'ModelDenyList').props.draft).toEqual(stored);
    // The restored lists differ from the saved ones, so the save is armed.
    expect(root.findAllByType('Button' as never).at(-1)?.props.disabled).toBe(false);
    // Nothing was typed, so nothing is written back over the restored draft.
    expect(draftStore.save).not.toHaveBeenCalled();
  });

  it('keeps an edit made before the stored draft lands', () => {
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;
    changeDraft(root, toggleModel(draft, 'openai/gpt', false));

    // The hook writes through while it still reports `loading`, so the edit
    // reached the store before the load settled.
    expect(draftStore.save).toHaveBeenCalledTimes(1);
    expect(draftStore.save.mock.calls[0]?.[0]).toEqual({
      providerAllowList: ['anthropic'],
      modelDenyList: ['openai/gpt'],
    });

    // The load settles after the edit: the person's change wins.
    draftStore.kind = 'ready';
    draftStore.value = { providerAllowList: ['anthropic'], modelDenyList: ['anthropic/claude'] };
    const rerendered = rerender(['anthropic']);

    expect(list(rerendered, 'ModelDenyList').props.draft).toEqual({
      providerAllowList: ['anthropic'],
      modelDenyList: ['openai/gpt'],
    });
  });

  it('keeps the tab the person chose when the stored draft lands afterwards', () => {
    const root = render(['anthropic']);
    selectTab(root, 'providers');

    draftStore.kind = 'ready';
    draftStore.value = { providerAllowList: ['openai'], modelDenyList: [] };
    const rerendered = rerender(['anthropic']);
    selectTab(rerendered, 'models');

    expect(list(rerendered, 'ModelDenyList').props.draft).toEqual({
      providerAllowList: ['anthropic'],
      modelDenyList: [],
    });
  });

  it('keeps a restored provider list when the catalog arrives afterwards', () => {
    // The store answers before the catalog does: the draft restores onto the
    // provisional rows, and the catalog's arrival must not overwrite it with
    // the saved list.
    draftStore.kind = 'ready';
    draftStore.value = { providerAllowList: ['openai'], modelDenyList: [] };
    render(['anthropic'], { catalogUnavailable: true });

    const root = renderWithCatalog(['anthropic']);
    selectTab(root, 'providers');
    const providers = list(root, 'ProviderAllowList');

    expect(providers.props.providers).toEqual(['anthropic', 'openai']);
    expect((providers.props.draft as ModelAccessDraft).providerAllowList).toEqual(['openai']);
  });

  it('saves the whole draft on every edit', () => {
    draftStore.kind = 'ready';
    draftStore.value = null;
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));

    expect(draftStore.save).toHaveBeenCalledTimes(1);
    expect(draftStore.save.mock.calls[0]?.[0]).toEqual({
      providerAllowList: ['anthropic'],
      modelDenyList: ['openai/gpt'],
    });
  });

  it('clears the stored draft once a save settles', async () => {
    draftStore.kind = 'ready';
    draftStore.value = null;
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    await pressSave(root);
    await act(async () => {
      await Promise.resolve();
    });

    expect(draftStore.clear).toHaveBeenCalledTimes(1);
  });

  it('clears the stored draft when a save settles before the draft answers', async () => {
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    await pressSave(root);
    await act(async () => {
      await Promise.resolve();
    });

    expect(draftStore.clear).toHaveBeenCalledTimes(1);
  });

  it('drops the stored draft on Cancel before the draft answers', () => {
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    pressCancel(root);

    // The store had not settled yet, and Cancel still drops the durable copy:
    // the hook writes that clear through while it reports `loading`.
    expect(draftStore.clear).toHaveBeenCalledTimes(1);
  });

  it('drops the stored draft when the person cancels their edits', () => {
    draftStore.kind = 'ready';
    draftStore.value = null;
    const root = render(['anthropic']);
    const draft = list(root, 'ModelDenyList').props.draft as ModelAccessDraft;

    changeDraft(root, toggleModel(draft, 'openai/gpt', false));
    expect(draftStore.save).toHaveBeenCalledTimes(1);
    expect(list(root, 'ModelDenyList').props.draft).toEqual({
      providerAllowList: ['anthropic'],
      modelDenyList: ['openai/gpt'],
    });

    pressCancel(root);

    // Cancel threw the edit away on purpose, so the durable copy goes with it:
    // a language-direction reload must not bring the edit back.
    expect(draftStore.clear).toHaveBeenCalledTimes(1);
    expect(list(root, 'ModelDenyList').props.draft).toEqual({
      providerAllowList: ['anthropic'],
      modelDenyList: [],
    });
  });
});
