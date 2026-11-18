// The guardrails form computes its dirty draft but left Back ungated: one press
// dropped the draft and returned to the Profile tab root. This suite drives the
// shared leave guard through the form's own edit paths — a detector edit,
// Cancel, a settled save — against a real `useMetadataLeaveGuard` with the
// navigator's removal request mocked the way
// `profile-overview-screen.guard.mounted.test.tsx` drives it. The sections are
// stubs that forward their `onChange`, so the suite exercises the form's dirty
// accounting, not the sections' internal editors (they have their own suites).
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuardrailsForm } from './guardrails-form';
import { i18n } from '@/i18n';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { type GuardrailsDraft, type OrgGuardrails } from '@/lib/organization/guardrails-draft';

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
  /** The edit callback the stubbed input section forwards to the form. */
  sectionOnChange: null as ((update: (current: GuardrailsDraft) => GuardrailsDraft) => void) | null,
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
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  I18nManager: { isRTL: false },
  Platform: { OS: 'android', select: (options: { android: unknown }) => options.android },
  useColorScheme: () => 'light',
}));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: () => undefined }));
vi.mock('expo-battery', () => ({
  BatteryState: { UNPLUGGED: 0, CHARGING: 1, FULL: 2 },
  useBatteryLevel: () => 1,
  useBatteryState: () => 2,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => 0 },
  FadeOut: { duration: () => 0 },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useSaveOrgGuardrails: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock('@/components/organization/guardrails-input-section', () => ({
  InputGuardrailsSection: (props: {
    onChange: (update: (current: GuardrailsDraft) => GuardrailsDraft) => void;
  }) => {
    h.sectionOnChange = props.onChange;
    return createElement('InputGuardrailsSection');
  },
}));
vi.mock('@/components/organization/guardrails-output-section', () => ({
  OutputGuardrailsSection: () => null,
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
// The real Button renders the actions the suite presses; its spinner's motion
// read is mocked, and Text is the host stub above.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});

/** The saved configuration the form starts from, in the router's output shape. */
function payload(): OrgGuardrails {
  return {
    enabled: true,
    group_id: null,
    // Kilo Default (`createKiloDefaultEnkryptInputDetectors` in web-shared):
    // the configuration the router answers for an organization that never
    // saved guardrails.
    detectors: {
      injection_attack: { enabled: true, action: 'log' },
      pii: { enabled: false, action: 'log', entities: ['secrets'] },
      keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
      topic_detector: { enabled: false, action: 'block', topic: [] },
      policy_violation: {
        enabled: false,
        action: 'block',
        format: 'rules',
        policy_text: '',
        rules: [],
      },
      toxicity: { enabled: false },
      nsfw: { enabled: false },
      bias: { enabled: false, action: 'log' },
      sponge_attack: { enabled: false },
    },
    output: {
      enabled: false,
      detectors: {
        pii: { enabled: false, action: 'block', entities: ['secrets'] },
        toxicity: { enabled: false, action: 'block' },
        nsfw: { enabled: false, action: 'block' },
        bias: { enabled: false, action: 'log' },
        keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
        topic_detector: { enabled: false, action: 'block', topic: [] },
      },
    },
    output_available: false,
    invalid_saved_detectors: false,
    invalid_saved_output_detectors: false,
    groups: [],
  };
}

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
  const handler = h.guard.handler;
  if (!handler) {
    throw new Error('the leave guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        h.repeatSawEnabled.push(h.guard.enabled);
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
  visit((node.props as WidgetProps).children);
  return parts.join(' ').replaceAll(/\s+/g, ' ').trim();
}

function pressLabelledButton(root: TestNode, label: string): void {
  const node = findAll(root, 'Pressable').find(candidate => textOf(candidate) === label);
  if (!node) {
    throw new Error(`no button labelled ${label}`);
  }
  act(() => {
    ((node.props as WidgetProps).onPress as () => void)();
  });
}

function findAll(root: TestNode, type: string): TestNode[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The status line the form paints above its buttons. */
function statusText(root: TestNode): string | undefined {
  const status = findAll(root, 'AccessibleStatus')[0];
  if (!status) {
    return undefined;
  }
  const message = (status.props as WidgetProps).message;
  return typeof message === 'string' ? message : undefined;
}

/** Renderers each test left open; a failing assertion still releases its tree. */
const openUnmounts: (() => void)[] = [];

/** The one detector edit the suite makes: the input guardrail's master switch. */
function editInputToggle(): void {
  const onChange = h.sectionOnChange;
  if (!onChange) {
    throw new Error('the input section did not render');
  }
  act(() => {
    onChange(current => ({ ...current, inputEnabled: !current.inputEnabled }));
  });
}

async function mountForm() {
  const { renderer, unmount } = await renderWithProviders(
    createElement(GuardrailsForm, { organizationId: 'org-1', data: payload() })
  );
  openUnmounts.push(unmount);
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLeaveSettle();
  h.repeatSawEnabled = [];
  h.guard.enabled = false;
  h.guard.handler = undefined;
  h.mutateAsync.mockReset();
  h.sectionOnChange = null;
});

afterEach(() => {
  for (const unmount of openUnmounts.splice(0)) {
    unmount();
  }
});

describe('GuardrailsForm leave guard', () => {
  it('leaves a clean form without asking', async () => {
    await mountForm();

    expect(h.guard.enabled).toBe(false);
  });

  it('asks Keep editing / Discard on Back from a dirty draft, and Keep editing keeps the edit', async () => {
    const renderer = await mountForm();

    // One detector edit: the same class of change the explorer made when it
    // picked a framework chip inside a saved rule.
    editInputToggle();
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
    // The edit survives: the status line still reports unsaved changes.
    expect(statusText(renderer.root)).toBe(i18n.t('securityAgent.settingsSave.unsavedTitle'));
  });

  it('Discard replays the leave and disarms the guard', async () => {
    await mountForm();

    editInputToggle();
    pressBack();

    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });

    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.repeatSawEnabled).toEqual([false]);
    expect(h.guard.enabled).toBe(false);
  });

  it('Cancel disarms the guard', async () => {
    const renderer = await mountForm();

    editInputToggle();
    expect(h.guard.enabled).toBe(true);

    pressLabelledButton(renderer.root, i18n.t('common.cancel'));

    expect(h.guard.enabled).toBe(false);
  });

  it('disarms the guard once a save settles, so Back leaves without asking', async () => {
    h.mutateAsync.mockResolvedValue({ ...payload(), enabled: false });
    const renderer = await mountForm();

    editInputToggle();
    expect(h.guard.enabled).toBe(true);

    pressLabelledButton(renderer.root, i18n.t('common.save'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.guard.enabled).toBe(false);

    pressBack();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
  });
});
