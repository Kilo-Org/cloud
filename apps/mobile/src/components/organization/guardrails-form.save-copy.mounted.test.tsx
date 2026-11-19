// The guardrails form's save-failure line. A known server sentence — above all
// the lapsed organization plan — becomes the localized explanation instead of
// echoing the server's English words, and an unrecognized rejection falls back
// to the surface's own failure line; a raw server sentence never shows.
//
// The sections are stubs that forward their `onChange`, the way
// `guardrails-screen.guard.mounted.test.tsx` drives the form: the subject here
// is the save-failure line above the buttons, not the editors' internals.
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuardrailsForm } from './guardrails-form';
import { i18n } from '@/i18n';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { type GuardrailsDraft, type OrgGuardrails } from '@/lib/organization/guardrails-draft';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  /** The edit callback the stubbed input section forwards to the form. */
  sectionOnChange: null as ((update: (current: GuardrailsDraft) => GuardrailsDraft) => void) | null,
}));

vi.mock('expo-router', () => ({ usePreventRemove: () => undefined }));
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
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
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
      topic_detector: { enabled: false, topic: [] },
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
        policy_violation: {
          enabled: false,
          action: 'block',
          format: 'rules',
          policy_text: '',
          rules: [],
        },
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

function pressLabelledButton(root: TestNode, label: string): void {
  const node = findAll(root, 'Pressable').find(candidate => textOf(candidate) === label);
  if (!node) {
    throw new Error(`no button labelled ${label}`);
  }
  act(() => {
    ((node.props as WidgetProps).onPress as () => void)();
  });
}

/** Renderers each test left open; a failing assertion still releases its tree. */
const openUnmounts: (() => void)[] = [];

/** One detector edit, so the form is dirty and its save is armed. */
function editInputToggle(): void {
  const onChange = h.sectionOnChange;
  if (!onChange) {
    throw new Error('the input section did not render');
  }
  act(() => {
    onChange(current => ({ ...current, inputEnabled: !current.inputEnabled }));
  });
}

/** Settle the save's promise chain, then let the failure paint. */
async function pressSave(renderer: { root: TestNode }): Promise<void> {
  editInputToggle();
  pressLabelledButton(renderer.root, i18n.t('common.save'));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountForm(refusedMessage: string) {
  h.mutateAsync.mockReset();
  h.mutateAsync.mockRejectedValue(
    Object.assign(new Error(refusedMessage), {
      data: { code: 'FORBIDDEN', message: refusedMessage },
    })
  );
  function Harness() {
    const [data] = useState(() => payload());
    return createElement(GuardrailsForm, { organizationId: 'org-1', data });
  }
  const { renderer, unmount } = await renderWithProviders(createElement(Harness));
  openUnmounts.push(unmount);
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLeaveSettle();
  h.mutateAsync.mockReset();
  h.sectionOnChange = null;
});

afterEach(() => {
  for (const unmount of openUnmounts.splice(0)) {
    unmount();
  }
});

describe('GuardrailsForm save copy', () => {
  it('shows the localized trial-ended line for the lapsed-plan refusal', async () => {
    const renderer = await mountForm(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    await pressSave(renderer);

    expect(statusText(renderer.root)).toBe(i18n.t('common.organizationTrialEnded'));
  });

  it('falls back to the status-failed line for an unrecognized refusal', async () => {
    const renderer = await mountForm('Failed to update guardrails');
    await pressSave(renderer);

    expect(statusText(renderer.root)).toBe(i18n.t('organizationGuardrails.statusFailed'));
  });
});