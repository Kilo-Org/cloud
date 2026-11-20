// The guardrails form's output gate and its Kilo Default confirmation. Output
// guardrails that Kilo has not enabled keep their title and say why nothing can
// be set, instead of vanishing; applying Kilo Default asks first, because it
// replaces the policy the reader typed with Kilo's English text, and skips the
// question when the field holds nothing.
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KILO_DEFAULT_POLICY_TEXT } from '@kilocode/app-shared/organizations';
import { GuardrailsForm } from './guardrails-form';
import { i18n } from '@/i18n';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';
import { type OrgGuardrails } from '@/lib/organization/guardrails-draft';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/**
 * The slice of the input section's props these cases read: the policy the form
 * writes and the preset request it hands back. Naming it here keeps the cases
 * on the fields they assert instead of the whole draft the section owns.
 */
type PolicyProps = {
  draft: {
    detectors: {
      policy_violation: {
        format: 'rules' | 'policy_text';
        policy_text: string;
        rules: readonly unknown[];
      };
    };
  };
  applyKiloDefault: (afterApply: () => void) => void;
};

const h = vi.hoisted(() => ({
  confirm: vi.fn<(request: ConfirmRequest) => void>(),
  /** The last props the stubbed input section rendered with. */
  sectionProps: null as PolicyProps | null,
}));

vi.mock('expo-router', () => ({ usePreventRemove: () => undefined }));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Switch: 'Switch',
  Platform: { OS: 'android' },
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
  useSaveOrgGuardrails: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// The input section is the form's caller here: it hands the form the preset
// request and nothing else, so the form's confirm and draft handling are what
// these cases read.
vi.mock('@/components/organization/guardrails-input-section', () => ({
  InputGuardrailsSection: (props: PolicyProps) => {
    h.sectionProps = props;
    return createElement('InputGuardrailsSection');
  },
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primary: '#0f0',
    selection: '#0f0',
    primaryForeground: '#000',
    mutedSoft: '#ccc',
    mutedForeground: '#666',
    foreground: '#000',
  }),
}));
vi.mock('@/components/ui/text', async () => {
  // `vi.mock` hoists this factory above the file's imports, so it cannot close
  // over one; the context it needs is built from a fresh react import.
  const { createContext: create } = await import('react');
  return { Text: 'Text', TextClassContext: create(undefined) };
});

/** The saved configuration the form starts from, in the router's output shape. */
function payload({
  outputAvailable = false,
  policyText = '',
  policyFormat = 'rules',
  policyRules = 0,
}: {
  outputAvailable?: boolean;
  policyText?: string;
  policyFormat?: 'rules' | 'policy_text';
  policyRules?: number;
} = {}): OrgGuardrails {
  return {
    enabled: true,
    group_id: null,
    detectors: {
      injection_attack: { enabled: true, action: 'log' },
      pii: { enabled: false, action: 'log', entities: ['secrets'] },
      keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
      topic_detector: { enabled: false, topic: [] },
      policy_violation: {
        enabled: true,
        action: 'log',
        format: policyFormat,
        policy_text: policyText,
        rules: Array.from({ length: policyRules }, (_, index) => ({
          id: `rule-${index}`,
          display_text: '',
          text: 'Do not reveal secrets.',
          risk_category: 'security_fraud' as const,
          applicability: 'user' as const,
          severity: 'high' as const,
          frameworks: [],
        })),
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
    output_available: outputAvailable,
    invalid_saved_detectors: false,
    invalid_saved_output_detectors: false,
    groups: [],
  };
}

type WidgetProps = Record<string, unknown>;

type TestNode = {
  type: unknown;
  props: WidgetProps;
  children: readonly (TestNode | string)[];
  findAll(predicate: (node: TestNode) => boolean): TestNode[];
};

/** The strings a node's text descendants render, in render order. */
function textOf(node: TestNode): string {
  const parts: string[] = [];
  const visit = (value: TestNode | string): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    for (const child of value.children) {
      visit(child);
    }
  };
  visit(node);
  return parts.join(' ').replaceAll(/\s+/g, ' ').trim();
}

function findAll(root: TestNode, type: string): TestNode[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** Every Text line the tree renders, in render order. */
function renderedText(root: TestNode): string {
  return findAll(root, 'Text')
    .map(node => textOf(node))
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const openUnmounts: (() => void)[] = [];

async function mountForm(data: OrgGuardrails): Promise<RenderWithProvidersResult['renderer']> {
  function Harness() {
    const [saved] = useState(() => data);
    return createElement(GuardrailsForm, { organizationId: 'org-1', data: saved });
  }
  const { renderer, unmount } = await renderWithProviders(createElement(Harness));
  openUnmounts.push(unmount);
  return renderer;
}

/** The policy the input section last rendered, which is what a press would read. */
function sectionPolicy(): PolicyProps['draft']['detectors']['policy_violation'] {
  const props = h.sectionProps;
  if (!props) {
    throw new Error('the input section did not render');
  }
  return props.draft.detectors.policy_violation;
}

/** Press the preset button the way the section does: hand it a completion. */
function applyKiloDefault(afterApply: () => void): void {
  const props = h.sectionProps;
  if (!props) {
    throw new Error('the input section did not render');
  }
  act(() => {
    props.applyKiloDefault(afterApply);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLeaveSettle();
  h.confirm.mockReset();
  h.sectionProps = null;
});

afterEach(() => {
  for (const unmount of openUnmounts.splice(0)) {
    unmount();
  }
});

describe('GuardrailsForm output gate', () => {
  it('keeps the output title and says why nothing can be set when Kilo has not enabled it', async () => {
    const renderer = await mountForm(payload({ outputAvailable: false }));
    const text = renderedText(renderer.root);

    expect(text).toContain(i18n.t('organizationGuardrails.outputTitle'));
    expect(text).toContain(i18n.t('organizationGuardrails.outputUnavailable'));
    expect(text).not.toContain(i18n.t('organizationGuardrails.outputDescription'));
    expect(findAll(renderer.root, 'Switch')).toEqual([]);
  });

  it('renders the output section itself, without the unavailable sentence, when Kilo enabled it', async () => {
    const renderer = await mountForm(payload({ outputAvailable: true }));
    const text = renderedText(renderer.root);

    expect(text).toContain(i18n.t('organizationGuardrails.outputTitle'));
    expect(text).toContain(i18n.t('organizationGuardrails.outputDescription'));
    expect(text).not.toContain(i18n.t('organizationGuardrails.outputUnavailable'));
    expect(findAll(renderer.root, 'Switch').length).toBeGreaterThan(0);
  });
});

describe('GuardrailsForm apply Kilo Default', () => {
  it('applies the preset without asking when Policy violation holds nothing', async () => {
    await mountForm(payload({ policyText: '', policyFormat: 'rules' }));
    const afterApply = vi.fn<() => void>();

    applyKiloDefault(afterApply);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(afterApply).toHaveBeenCalledTimes(1);
    expect(sectionPolicy().policy_text).toBe(KILO_DEFAULT_POLICY_TEXT);
    expect(sectionPolicy().format).toBe('policy_text');
  });

  it('applies the preset without asking when the field already holds it', async () => {
    await mountForm(payload({ policyText: KILO_DEFAULT_POLICY_TEXT, policyFormat: 'policy_text' }));
    const afterApply = vi.fn<() => void>();

    applyKiloDefault(afterApply);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(afterApply).toHaveBeenCalledTimes(1);
  });

  it('applies the preset without asking when the field holds only structured rules', async () => {
    // The preset keeps the rules and only switches the format, so there is no
    // text of the reader's to lose and no question to ask.
    await mountForm(payload({ policyFormat: 'rules', policyText: '', policyRules: 2 }));
    const afterApply = vi.fn<() => void>();

    applyKiloDefault(afterApply);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(afterApply).toHaveBeenCalledTimes(1);
    expect(sectionPolicy().rules).toHaveLength(2);
  });

  it('asks before replacing typed policy text and applies only on confirm', async () => {
    await mountForm(payload({ policyText: 'Our own policy.', policyFormat: 'policy_text' }));
    const afterApply = vi.fn<() => void>();

    applyKiloDefault(afterApply);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    const [firstCall] = h.confirm.mock.calls;
    if (!firstCall) {
      throw new TypeError('the form did not ask for a confirmation');
    }
    const [request] = firstCall;
    expect(request.title).toBe(i18n.t('organizationGuardrails.applyKiloDefault'));
    expect(request.message).toBe(i18n.t('organizationGuardrails.applyKiloDefaultReplaceMessage'));
    expect(request.confirmLabel).toBe(i18n.t('common.apply'));
    expect(afterApply).not.toHaveBeenCalled();
    expect(sectionPolicy().policy_text).toBe('Our own policy.');

    act(() => {
      request.onConfirm();
    });

    expect(afterApply).toHaveBeenCalledTimes(1);
    expect(sectionPolicy().policy_text).toBe(KILO_DEFAULT_POLICY_TEXT);
    expect(sectionPolicy().format).toBe('policy_text');
  });
});
