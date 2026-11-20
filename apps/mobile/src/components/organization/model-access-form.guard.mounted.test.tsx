/* eslint-disable max-lines -- One suite drives the shared leave guard through every edit path of this form (an edit, Cancel, a settled save, a rebasing refetch); splitting it would duplicate the mocked data layer and fixture. */
// The providers-and-models form keeps a draft that only saves on request, so
// Back must not drop it silently. This suite drives the shared leave guard
// through the form's own edit paths — a deny-list toggle, Cancel, a settled
// save, a refetch that rebases the form — against the real
// `useMetadataLeaveGuard`, with the navigator's removal request mocked the way
// `guardrails-screen.guard.mounted.test.tsx` drives it. The deny list is a
// stub that forwards its `onChange`, so the suite exercises the form's dirty
// accounting, not the list's own rows (they have their own suite).
//
// The form's dirty flag is a derivation of its own draft, so a discarded draft
// still differs from the baseline: the guard only stays disarmed because the
// granted pop removes the route, which the hook reads through
// `useNavigationFocusRead`. This harness models that removal — the seam is
// mocked, and the replayed removal reports the screen unfocused once, the state
// a granted pop leaves behind.
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelAccessForm } from './model-access-form';
import { i18n } from '@/i18n';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
import {
  type CatalogModel,
  type ModelAccessDraft,
  toggleModel,
} from '@/lib/organization/model-access';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

type FormProps = Readonly<{
  canEdit: boolean;
  providerAllowList: readonly string[] | undefined;
  modelDenyList: readonly string[];
}>;

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  repeat: vi.fn(),
  repeatSawEnabled: [] as boolean[],
  guard: {
    enabled: false as boolean,
    handler: undefined as
      | ((options: { data: { action: { type: string } }; repeat: () => void }) => void)
      | undefined,
  },
  mutateAsync: vi.fn(),
  /** Whether the screen still holds the focused route; a granted pop clears it. */
  routeFocused: true,
  /** The edit callback the stubbed deny list forwards to the form. */
  listOnChange: null as ((next: ModelAccessDraft) => void) | null,
  /** Assigned by the harness; moves the props a refetch would deliver. */
  moveProps: null as ((next: FormProps) => void) | null,
}));

vi.mock('expo-router', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
  ) => {
    h.guard.enabled = enabled;
    h.guard.handler = handler;
  },
}));
vi.mock('@/lib/navigation/route-focus', () => ({
  useNavigationFocusRead: () => () => h.routeFocused,
  // No dispatch queue exists outside the Expo root, so it always reports drained.
  useNavigationQueueSettled: () => true,
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  I18nManager: { isRTL: false },
  Platform: { OS: 'android', select: (options: { android: unknown }) => options.android },
  useColorScheme: () => 'light',
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useSaveOrgModelAccess: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock('@/components/organization/model-access-lists', async () => {
  const { createElement: render } = await import('react');
  return {
    ModelDenyList: (props: {
      draft: ModelAccessDraft;
      onChange: (next: ModelAccessDraft) => void;
    }) => {
      h.listOnChange = props.onChange;
      return render('ModelDenyList', props);
    },
    ProviderAllowList: 'ProviderAllowList',
  };
});
vi.mock('@/components/organization/providers-gateways-section', () => ({
  GatewaySettingsSection: 'GatewaySettingsSection',
}));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
// The real Button renders the actions the suite presses; its spinner's motion
// read is mocked, and Text is the host stub below.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});

function model(id: string, providers: readonly string[]): CatalogModel {
  return { id, name: id, inference_provider_ids: [...providers] } satisfies CatalogModel;
}

/** Two providers, so denying one model still leaves a route the save accepts. */
const CATALOG = [model('anthropic/claude', ['anthropic']), model('openai/gpt', ['openai'])];

type WidgetProps = Record<string, unknown>;

type TestNode = {
  type: unknown;
  props: WidgetProps;
  findAll(predicate: (node: TestNode) => boolean): TestNode[];
};

function discardRequest() {
  const request = h.confirm.mock.calls.at(-1)?.[0] as
    | { onConfirm?: () => void; onCancel?: () => void }
    | undefined;
  if (!request) {
    throw new Error('the discard confirmation was not raised');
  }
  return request;
}

/** Hand the guard the removal the navigator produces for a Back press. */
function pressBack() {
  // A disabled guard registers no interception, so the navigator removes the
  // route without consulting it. Modelling that is what lets a test tell an
  // armed guard from one the screen turned off.
  if (!h.guard.enabled) {
    h.routeFocused = false;
    h.repeat();
    return;
  }
  const handler = h.guard.handler;
  if (!handler) {
    throw new Error('the leave guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        h.repeatSawEnabled.push(h.guard.enabled);
        // The navigator granted the removal, so this screen stops holding the
        // focused route, the read the guard takes before it disarms again.
        h.routeFocused = false;
        h.repeat();
      },
    });
  });
}

/** The strings a node's Text descendants render, by `children` prop. */
function textOf(node: TestNode): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined || typeof value === 'boolean') {
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
      return;
    }
    // A React element carries its own text one level down.
    if (typeof value === 'object' && 'props' in value) {
      visit((value as { props: { children?: unknown } }).props.children);
    }
  };
  visit(node.props.children);
  return parts.join(' ').replaceAll(/\s+/g, ' ').trim();
}

function findAll(root: TestNode, type: string): TestNode[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function pressLabelledButton(root: TestNode, label: string): void {
  const node = findAll(root, 'Pressable').find(candidate => textOf(candidate) === label);
  if (!node) {
    throw new Error(`no button labelled ${label}`);
  }
  act(() => {
    (node.props.onPress as () => void)();
  });
}

async function pressSave(root: TestNode): Promise<void> {
  const node = findAll(root, 'Pressable').find(
    candidate => textOf(candidate) === i18n.t('common.save')
  );
  if (!node) {
    throw new Error('the save button did not render');
  }
  await act(async () => {
    (node.props.onPress as () => void)();
    await Promise.resolve();
  });
}

/** The one edit the suite makes: deny a model a remaining provider still serves. */
function denyOneModel(root: TestNode): void {
  const list = findAll(root, 'ModelDenyList')[0];
  const onChange = h.listOnChange;
  if (!list || !onChange) {
    throw new Error('the deny list did not render');
  }
  act(() => {
    onChange(toggleModel(list.props.draft as ModelAccessDraft, 'anthropic/claude', false));
  });
}

/** Renderers each test left open; a failing assertion still releases its tree. */
const openUnmounts: (() => void)[] = [];

async function mountForm(overrides: Partial<FormProps> = {}) {
  const initialProps: FormProps = {
    canEdit: true,
    providerAllowList: undefined,
    modelDenyList: [],
    ...overrides,
  };
  // The form reads the saved lists through its props, the way production
  // delivers a refetch's answer. The holder lets a test move them.
  function Harness() {
    const [props, setProps] = useState(initialProps);
    h.moveProps = next => {
      act(() => {
        setProps(next);
      });
    };
    return createElement(ModelAccessForm, {
      organizationId: 'org-1',
      models: [],
      catalog: CATALOG,
      catalogUnavailable: false,
      catalogIsFetching: false,
      onRetryCatalog: () => undefined,
      gateway: undefined,
      gatewayIsError: false,
      gatewayIsFetching: false,
      onRetryGateway: () => undefined,
      ...props,
    });
  }
  const { renderer, unmount } = await renderWithProviders(createElement(Harness));
  openUnmounts.push(unmount);
  return renderer.root as unknown as TestNode;
}

function moveProps(next: FormProps): void {
  const move = h.moveProps;
  if (!move) {
    throw new Error('the harness did not mount');
  }
  move(next);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLeaveSettle();
  h.repeatSawEnabled = [];
  h.routeFocused = true;
  h.guard.enabled = false;
  h.guard.handler = undefined;
  h.mutateAsync.mockReset();
  h.mutateAsync.mockResolvedValue(undefined);
  h.listOnChange = null;
  h.moveProps = null;
});

afterEach(() => {
  for (const unmount of openUnmounts.splice(0)) {
    unmount();
  }
});

describe('ModelAccessForm leave guard', () => {
  it('leaves a clean form without asking', async () => {
    await mountForm();

    expect(h.guard.enabled).toBe(false);
  });

  it('arms the guard on one model toggle', async () => {
    const root = await mountForm();

    denyOneModel(root);

    expect(h.guard.enabled).toBe(true);
  });

  it('asks Keep editing / Discard on Back from a dirty draft, and Keep editing keeps the edit', async () => {
    const root = await mountForm();

    denyOneModel(root);
    expect(h.guard.enabled).toBe(true);

    pressBack();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });

    act(() => {
      discardRequest().onCancel?.();
    });

    expect(h.repeat).not.toHaveBeenCalled();
    expect(h.guard.enabled).toBe(true);
  });

  it('Discard replays the leave and disarms the guard', async () => {
    const root = await mountForm();

    denyOneModel(root);
    pressBack();

    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });

    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.repeatSawEnabled).toEqual([false]);
    expect(h.guard.enabled).toBe(false);
  });

  it('Cancel disarms the guard, so a later Back leaves without a prompt', async () => {
    const root = await mountForm();

    denyOneModel(root);
    expect(h.guard.enabled).toBe(true);

    pressLabelledButton(root, i18n.t('common.cancel'));
    expect(h.guard.enabled).toBe(false);

    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
  });

  it('disarms the guard once a save settles, so Back leaves without asking', async () => {
    const root = await mountForm();

    denyOneModel(root);
    expect(h.guard.enabled).toBe(true);

    // The form rebases its own baseline onto the draft it just saved, so the
    // draft is clean once the write lands; no prop has to move for that.
    await pressSave(root);
    await act(async () => {
      await Promise.resolve();
    });

    expect(h.guard.enabled).toBe(false);

    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
  });

  it('keeps the guard disarmed when a refetch rebases a clean draft', async () => {
    await mountForm();

    expect(h.guard.enabled).toBe(false);

    // A refetch that moves the saved provider list under a clean form: the form
    // rebases onto the new payload without any edit of its own.
    moveProps({ canEdit: true, providerAllowList: ['anthropic'], modelDenyList: [] });
    await act(async () => {
      await Promise.resolve();
    });

    expect(h.guard.enabled).toBe(false);

    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
  });

  it('keeps the guard armed through a rebase when the draft holds edits', async () => {
    const root = await mountForm();

    denyOneModel(root);
    expect(h.guard.enabled).toBe(true);

    // The saved deny list moves while the draft holds an edit that differs from
    // it: the edit wins and stays dirty against the new baseline.
    moveProps({ canEdit: true, providerAllowList: undefined, modelDenyList: ['openai/gpt'] });
    await act(async () => {
      await Promise.resolve();
    });

    expect(h.guard.enabled).toBe(true);
  });

  it('never asks a read-only viewer, whose lists are disabled', async () => {
    const root = await mountForm({ canEdit: false });

    // The evidence the gate reads: the form disables the lists it would
    // otherwise let a manager edit, so the viewer cannot make a draft.
    expect(findAll(root, 'ModelDenyList')[0]?.props.disabled).toBe(true);

    // Drive the edit path anyway. A form that armed the guard regardless of the
    // viewer would prompt here, and this is the only state in which the route
    // could then hold unsaved edits.
    denyOneModel(root);
    expect(h.guard.enabled).toBe(false);

    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
  });
});
