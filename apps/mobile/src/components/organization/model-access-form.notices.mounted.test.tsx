// What the providers-and-models form offers and says, which the save contract
// does not cover: the Gateways segment exists only while the settings read
// reports gateways available, like the web page's Advanced policies tab, so an
// unavailable organization loses the tab instead of landing on an empty one.
// The sibling suite owns the save contract and keeps this harness small.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';

import { i18n as appI18n } from '@/i18n';
import { type OrgGatewaySettings } from '@/lib/hooks/use-org-settings-queries';
import { type ModelAccessDraft } from '@/lib/organization/model-access';
import { ModelAccessForm } from './model-access-form';

const saved = vi.hoisted(() => ({ mutateAsync: vi.fn<(input: unknown) => Promise<void>>() }));

vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useSaveOrgModelAccess: () => ({ mutateAsync: saved.mutateAsync, isPending: false }),
}));
// The form hands the plan state to the shared refusal and owns nothing about
// its paint: the primitive's own suite pins the mark and the tinted surface.
vi.mock('@/components/organization/plan-refusal', () => ({
  OrganizationPlanRefusal: 'OrganizationPlanRefusal',
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
// The real Button stays mounted: the lapsed-plan paint is the class the control
// derives from its own `variant` and `disabled`, so a stub that forwards props
// would only restate the arguments the form passes.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000', foreground: '#000000' }),
}));
vi.mock('@/components/organization/model-access-lists', () => ({
  ModelDenyList: 'ModelDenyList',
  ProviderAllowList: 'ProviderAllowList',
}));
vi.mock('@/components/organization/providers-gateways-section', () => ({
  GatewaySettingsSection: 'GatewaySettingsSection',
}));

/** The gateway settings read's payload, as the router answers it. */
const GATEWAY_AVAILABLE = {
  available: true,
  disable_openrouter: false,
  data_region: null,
} satisfies OrgGatewaySettings;
const GATEWAY_UNAVAILABLE = { ...GATEWAY_AVAILABLE, available: false };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

type FormOverrides = {
  gateway?: OrgGatewaySettings;
  gatewayIsError?: boolean;
  planEnded?: boolean;
  canEdit?: boolean;
};

/** The sentence and step the screen resolved, as this harness hands them in. */
const PLAN_MESSAGE = 'The plan lapsed for this organization.';
const planAction = { label: 'Manage billing', onPress: () => undefined };
const planProps = { planMessage: PLAN_MESSAGE, planAction };

function element(overrides: FormOverrides = {}) {
  return createElement(ModelAccessForm, {
    organizationId: 'org-1',
    canEdit: overrides.canEdit ?? true,
    planEnded: overrides.planEnded ?? false,
    ...planProps,
    models: [],
    catalog: [],
    catalogUnavailable: false,
    catalogIsFetching: false,
    onRetryCatalog: () => undefined,
    providerAllowList: undefined,
    modelDenyList: [],
    gateway: overrides.gateway,
    gatewayIsError: overrides.gatewayIsError ?? false,
    gatewayIsFetching: false,
    onRetryGateway: () => undefined,
  });
}

function render(overrides: FormOverrides = {}) {
  saved.mutateAsync.mockResolvedValue(undefined);
  act(() => {
    renderer = TestRenderer.create(element(overrides));
  });
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  return renderer.root;
}

/** Render the same form again, as the settings read answering would. */
function rerender(overrides: FormOverrides = {}) {
  if (!renderer) {
    throw new Error('Missing form renderer');
  }
  act(() => {
    renderer?.update(element(overrides));
  });
  return renderer.root;
}

/** The segment values the control offers, in order. */
function segmentValues(root: ReactTestInstance): string[] {
  const options = root.findByType('SegmentedControl' as never).props.options as readonly {
    value: string;
  }[];
  return options.map(option => option.value);
}

/** Every string a `Text` node renders. */
function renderedCopy(root: ReactTestInstance): string[] {
  return root
    .findAllByType('Text' as never)
    .map(node => node.props.children)
    .filter((value): value is string => typeof value === 'string');
}

/** Apply a draft edit through the list, as toggling a row would. */
function changeDraft(root: ReactTestInstance, edit: (draft: ModelAccessDraft) => ModelAccessDraft) {
  const list = root.findByType('ModelDenyList' as never);
  act(() => {
    (list.props.onChange as (next: ModelAccessDraft) => void)(
      edit(list.props.draft as ModelAccessDraft)
    );
  });
}

function selectTab(root: ReactTestInstance, tab: 'models' | 'providers' | 'gateways') {
  act(() => {
    (root.findByType('SegmentedControl' as never).props.onChange as (next: string) => void)(tab);
  });
}

function gatewaySections(root: ReactTestInstance) {
  return root.findAllByType('GatewaySettingsSection' as never);
}

/** The rendered pressables whose single label `Text` reads `label`. */
function controls(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root
    .findAll(node => Object.is(node.type, 'Pressable'))
    .filter(
      node =>
        node.findAll(child => Object.is(child.type, 'Text') && child.props.children === label)
          .length === 1
    );
}

/** The control whose single label `Text` reads `label`, as the rendered pressable. */
function labelledControl(root: ReactTestInstance, label: string): ReactTestInstance {
  const [found] = controls(root, label);
  if (!found) {
    throw new Error(`the ${label} control is missing`);
  }
  return found;
}

/** The shared plan refusal the form renders, which owns the sentence's paint. */
function refusals(root: ReactTestInstance) {
  return root.findAllByType('OrganizationPlanRefusal' as never);
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  saved.mutateAsync.mockReset();
});

describe('ModelAccessForm gateways tab', () => {
  it('offers the gateways segment when the settings read reports it available', () => {
    const root = render({ gateway: GATEWAY_AVAILABLE });

    expect(segmentValues(root)).toEqual(['models', 'providers', 'gateways']);
    selectTab(root, 'gateways');

    expect(root.findByType('SegmentedControl' as never).props.value).toBe('gateways');
    expect(gatewaySections(root)).toHaveLength(1);
  });

  it('leaves the gateways segment out while the settings read has not answered', () => {
    const root = render();

    expect(segmentValues(root)).toEqual(['models', 'providers']);
    expect(gatewaySections(root)).toHaveLength(0);
  });

  it('leaves the gateways segment out when the plan does not offer gateways', () => {
    const root = render({ gateway: GATEWAY_UNAVAILABLE });

    expect(segmentValues(root)).toEqual(['models', 'providers']);
    expect(gatewaySections(root)).toHaveLength(0);
  });

  it('falls back to the models tab when the gateways segment disappears', () => {
    const root = render({ gateway: GATEWAY_AVAILABLE });
    selectTab(root, 'gateways');
    expect(gatewaySections(root)).toHaveLength(1);

    // The read lands again without gateways while the tab is still selected:
    // the control and the rendered list both fall back, instead of the control
    // painting models while the gateways settings stay on screen.
    const next = rerender({ gateway: GATEWAY_UNAVAILABLE });

    expect(next.findByType('SegmentedControl' as never).props.value).toBe('models');
    expect(segmentValues(next)).toEqual(['models', 'providers']);
    expect(gatewaySections(next)).toHaveLength(0);
  });

  it('keeps the models tab after the segment leaves and returns', () => {
    const root = render({ gateway: GATEWAY_AVAILABLE });
    selectTab(root, 'gateways');
    expect(gatewaySections(root)).toHaveLength(1);

    // The read drops gateways while the tab is selected: the control falls
    // back to models, and the selection moves with it instead of staying on
    // the segment the read removed.
    const gone = rerender({ gateway: GATEWAY_UNAVAILABLE });
    expect(gone.findByType('SegmentedControl' as never).props.value).toBe('models');

    // A later read offers the segment again: the form keeps the models tab the
    // fallback chose rather than jumping back to gateways on its own.
    const back = rerender({ gateway: GATEWAY_AVAILABLE });

    expect(segmentValues(back)).toEqual(['models', 'providers', 'gateways']);
    expect(back.findByType('SegmentedControl' as never).props.value).toBe('models');
    expect(gatewaySections(back)).toHaveLength(0);
  });

  it('keeps the gateways segment offered while the settings read has failed', () => {
    const root = render({ gateway: undefined, gatewayIsError: true });
    selectTab(root, 'gateways');

    // The section owns this read's error and retry, so the segment stays
    // reachable: hiding it would leave a failed read unretryable on this
    // screen.
    expect(segmentValues(root)).toEqual(['models', 'providers', 'gateways']);
    expect(root.findByType('SegmentedControl' as never).props.value).toBe('gateways');
    const section = gatewaySections(root).at(0);
    expect(section?.props.isError).toBe(true);
    expect(section?.props.onRetry).toBeTypeOf('function');
  });
});

describe('ModelAccessForm read-only notice', () => {
  it('names the lapsed plan instead of the role for a member', () => {
    const root = render({ canEdit: false, planEnded: true });

    expect(refusals(root)).toHaveLength(1);
    expect(renderedCopy(root)).not.toContain(appI18n.t('organizationModelAccess.readOnly'));
  });

  it('keeps the role sentence for a member on an active plan', () => {
    const root = render({ canEdit: false, planEnded: false });

    expect(renderedCopy(root)).toContain(appI18n.t('organizationModelAccess.readOnly'));
    expect(refusals(root)).toHaveLength(0);
  });

  it('shows the lapsed plan to an admin too', () => {
    const root = render({ canEdit: true, planEnded: true });

    expect(refusals(root)).toHaveLength(1);
    expect(renderedCopy(root)).not.toContain(appI18n.t('organizationModelAccess.readOnly'));
  });

  it('shows no notice to an admin on an active plan', () => {
    const root = render({ canEdit: true, planEnded: false });

    expect(refusals(root)).toHaveLength(0);
    expect(renderedCopy(root)).not.toContain(appI18n.t('organizationModelAccess.readOnly'));
  });
});

describe('ModelAccessForm lapsed-plan controls', () => {
  it('hands the shared refusal the plan-ended sentence and step once, under the segments', () => {
    const root = render({ canEdit: true, planEnded: true });
    const found = refusals(root);

    expect(found).toHaveLength(1);
    const refusal = found.at(0);
    if (!refusal) {
      throw new Error('the plan refusal is missing');
    }
    // The form paints the sentence and the step the screen resolved: it owns
    // neither, so the exact values it was handed are what must arrive.
    expect(refusal.props.message).toBe(PLAN_MESSAGE);
    expect(refusal.props.action).toBe(planAction);

    // The block sits directly under the segments, above the role caption slot
    // the plan state replaces.
    const control = root.findByType('SegmentedControl' as never);
    const siblings = refusal.parent?.children ?? [];
    expect(siblings.indexOf(control)).toBeLessThan(siblings.indexOf(refusal));

    // The plan state is the refusal's sentence, not a save failure, and a
    // clean draft leaves no status line behind it either.
    expect(root.findAllByType('AccessibleStatus' as never)).toHaveLength(0);
  });

  it('disables save and the lists while the plan lapsed, even with edits', () => {
    // A clean draft already disables Save through `!dirty`, so the plan gate is
    // only observable after an edit dirties the draft: the same denial must
    // leave Save and both lists enabled on an active plan, and disabled under a
    // lapsed one.
    const deny = (draft: ModelAccessDraft): ModelAccessDraft => ({
      ...draft,
      modelDenyList: ['anthropic/claude'],
    });

    const active = render({ canEdit: true, planEnded: false });
    changeDraft(active, deny);
    expect(labelledControl(active, appI18n.t('common.save')).props.disabled).toBe(false);
    expect(active.findByType('ModelDenyList' as never).props.disabled).toBe(false);
    selectTab(active, 'providers');
    expect(active.findByType('ProviderAllowList' as never).props.disabled).toBe(false);
    act(() => renderer?.unmount());

    const lapsed = render({ canEdit: true, planEnded: true });
    changeDraft(lapsed, deny);
    expect(labelledControl(lapsed, appI18n.t('common.save')).props.disabled).toBe(true);
    expect(lapsed.findByType('ModelDenyList' as never).props.disabled).toBe(true);
    selectTab(lapsed, 'providers');
    expect(lapsed.findByType('ProviderAllowList' as never).props.disabled).toBe(true);
  });

  it('releases the save when the plan gate clears', () => {
    const lapsed = render({ canEdit: true, planEnded: true });
    changeDraft(lapsed, draft => ({ ...draft, modelDenyList: ['anthropic/claude'] }));
    expect(labelledControl(lapsed, appI18n.t('common.save')).props.disabled).toBe(true);

    const next = rerender({ canEdit: true, planEnded: false });

    expect(labelledControl(next, appI18n.t('common.save')).props.disabled).toBe(false);
  });

  it('leaves the controls out but keeps their place while the plan lapsed', () => {
    // A clean draft already disables Save through `!dirty` and Cancel through
    // the same rule, so a lapsed plan with nothing to discard has no action
    // left: the controls leave rather than sit dead under the sentence that
    // states the blocker. Their height stays, so the list below does not move
    // when the gate arrives or clears.
    const root = render({ canEdit: true, planEnded: true });

    expect(controls(root, appI18n.t('common.save'))).toHaveLength(0);
    expect(controls(root, appI18n.t('common.cancel'))).toHaveLength(0);
    expect(
      root.findAll(
        node =>
          Object.is(node.type, 'View') &&
          String(node.props.className ?? '').includes('min-h-[36px]')
      )
    ).toHaveLength(1);
  });

  it('keeps the actions row with Cancel live and Save gated for a trapped draft', () => {
    // A draft the plan lapsed under can only be discarded through Cancel, which
    // reaches no server state, so the row stays and only Save takes the gate.
    const root = render({ canEdit: true, planEnded: true });
    changeDraft(root, draft => ({ ...draft, modelDenyList: ['anthropic/claude'] }));

    expect(labelledControl(root, appI18n.t('common.save')).props.disabled).toBe(true);
    expect(labelledControl(root, appI18n.t('common.cancel')).props.disabled).toBe(false);
  });

  it('keeps cancel usable to discard a draft the plan gate trapped', () => {
    // The lists are read-only and Save is gated, so a draft the plan lapsed
    // under could never be cleared if Cancel took the gate too. Cancel reaches
    // no server state, so it stays live and restores the baseline locally.
    const root = render({ canEdit: true, planEnded: true });
    const baseline = root.findByType('ModelDenyList' as never).props.draft as ModelAccessDraft;
    changeDraft(root, draft => ({ ...draft, modelDenyList: ['anthropic/claude'] }));

    expect(labelledControl(root, appI18n.t('common.save')).props.disabled).toBe(true);
    const cancel = labelledControl(root, appI18n.t('common.cancel'));
    // A disabled pressable takes no press, exactly as on device, so a gated
    // Cancel would leave the trapped draft in place.
    expect(cancel.props.disabled).toBe(false);
    act(() => {
      (cancel.props.onPress as () => void)();
    });
    // One report: the draft is the baseline again, and nothing was saved.
    expect(root.findByType('ModelDenyList' as never).props.draft).toEqual(baseline);
    expect(saved.mutateAsync).not.toHaveBeenCalled();
  });

  it('keeps save on the primary fill for a dirty draft on an active plan', () => {
    const root = render({ canEdit: true, planEnded: false });
    changeDraft(root, draft => ({ ...draft, modelDenyList: ['anthropic/claude'] }));

    const save = String(labelledControl(root, appI18n.t('common.save')).props.className ?? '');

    expect(save).toContain('bg-primary');
    expect(save).not.toContain('bg-primary-disabled-action');
    expect(save).not.toContain('opacity-50');
  });
});
