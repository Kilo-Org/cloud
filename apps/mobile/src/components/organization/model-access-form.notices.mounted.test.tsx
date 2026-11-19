// What the providers-and-models form offers and says, which the save contract
// does not cover: the Gateways segment exists only while the settings read
// reports gateways available, like the web page's Advanced policies tab, so an
// unavailable organization loses the tab instead of landing on an empty one;
// and a lapsed plan names itself in a warning banner instead of the role
// rule. The sibling suite owns the save contract and keeps this harness small.

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
vi.mock('@/components/ui/icons', () => ({ AlertTriangle: 'AlertTriangle' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ warn: '#956011' }),
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

function element(overrides: FormOverrides = {}) {
  return createElement(ModelAccessForm, {
    organizationId: 'org-1',
    canEdit: overrides.canEdit ?? true,
    planEnded: overrides.planEnded ?? false,
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
    const copy = renderedCopy(render({ canEdit: false, planEnded: true }));

    expect(copy).toContain(appI18n.t('common.organizationTrialEnded'));
    expect(copy).not.toContain(appI18n.t('organizationModelAccess.readOnly'));
  });

  it('keeps the role sentence for a member on an active plan', () => {
    const copy = renderedCopy(render({ canEdit: false, planEnded: false }));

    expect(copy).toContain(appI18n.t('organizationModelAccess.readOnly'));
    expect(copy).not.toContain(appI18n.t('common.organizationTrialEnded'));
  });

  it('shows the lapsed plan to an admin too', () => {
    const copy = renderedCopy(render({ canEdit: true, planEnded: true }));

    expect(copy).toContain(appI18n.t('common.organizationTrialEnded'));
    expect(copy).not.toContain(appI18n.t('organizationModelAccess.readOnly'));
  });

  it('shows no notice to an admin on an active plan', () => {
    const copy = renderedCopy(render({ canEdit: true, planEnded: false }));

    expect(copy).not.toContain(appI18n.t('common.organizationTrialEnded'));
    expect(copy).not.toContain(appI18n.t('organizationModelAccess.readOnly'));
  });
});

describe('ModelAccessForm lapsed-plan controls', () => {
  it('paints the plan-ended sentence as a warning banner above the segments', () => {
    const root = render({ canEdit: true, planEnded: true });
    const copy = appI18n.t('common.organizationTrialEnded');

    // The banner is one mark and the sentence; the sentence is body-sized
    // warning ink rather than the helper-sized muted caption it replaced.
    expect(root.findAllByType('AlertTriangle' as never)).toHaveLength(1);
    const sentence = root.findAllByType('Text' as never).find(node => node.props.children === copy);
    if (!sentence) {
      throw new Error('the plan-ended sentence is missing');
    }
    let banner = sentence.parent;
    while (banner !== null && !String(banner.props.className ?? '').includes('bg-warn-tile-bg')) {
      banner = banner.parent;
    }
    if (banner === null) {
      throw new Error('the plan-ended sentence is outside a tinted banner');
    }
    expect(String(banner.props.className)).toContain('border-warn-tile-border');
    expect(banner.findAllByType('AlertTriangle' as never)).toHaveLength(1);
    expect(String(sentence.props.className)).toContain('text-sm');
    expect(String(sentence.props.className)).toContain('text-warn');
  });

  it('keeps the role caption and no banner for a member on an active plan', () => {
    const root = render({ canEdit: false, planEnded: false });

    expect(renderedCopy(root)).toContain(appI18n.t('organizationModelAccess.readOnly'));
    expect(root.findAllByType('AlertTriangle' as never)).toHaveLength(0);
    expect(
      root.findAll(node => String(node.props.className ?? '').includes('bg-warn-tile-bg'))
    ).toHaveLength(0);
  });

  it('paints the plan-ended sentence once, in the notice above the segments', () => {
    const root = render({ canEdit: true, planEnded: true });
    const copy = renderedCopy(root);

    expect(copy.filter(text => text === appI18n.t('common.organizationTrialEnded'))).toHaveLength(
      1
    );
    expect(root.findByType('AccessibleStatus' as never).props.message).toBeNull();
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
    expect(active.findAllByType('Button' as never).at(-1)?.props.disabled).toBe(false);
    expect(active.findByType('ModelDenyList' as never).props.disabled).toBe(false);
    selectTab(active, 'providers');
    expect(active.findByType('ProviderAllowList' as never).props.disabled).toBe(false);
    act(() => renderer?.unmount());

    const lapsed = render({ canEdit: true, planEnded: true });
    changeDraft(lapsed, deny);
    expect(lapsed.findAllByType('Button' as never).at(-1)?.props.disabled).toBe(true);
    expect(lapsed.findByType('ModelDenyList' as never).props.disabled).toBe(true);
    selectTab(lapsed, 'providers');
    expect(lapsed.findByType('ProviderAllowList' as never).props.disabled).toBe(true);
  });

  it('releases the save when the plan gate clears', () => {
    const lapsed = render({ canEdit: true, planEnded: true });
    changeDraft(lapsed, draft => ({ ...draft, modelDenyList: ['anthropic/claude'] }));
    expect(lapsed.findAllByType('Button' as never).at(-1)?.props.disabled).toBe(true);

    const next = rerender({ canEdit: true, planEnded: false });

    expect(next.findAllByType('Button' as never).at(-1)?.props.disabled).toBe(false);
  });
});
