// The input guardrail's scope line and its preset button. The scope row states
// who the guardrail covers even when there is no group to pick, so the reader
// always learns it is everyone; the preset button hands the preset to the form
// (which asks before overwriting anything) and says the text it applies is
// English.
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InputGuardrailsSection } from './guardrails-input-section';
import { i18n } from '@/i18n';
import { type GuardrailsDraft, type OrgGuardrailsGroup } from '@/lib/organization/guardrails-draft';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  sheetVisible: false,
  applyKiloDefault: vi.fn<(afterApply: () => void) => void>(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Switch: 'Switch',
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
}));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: () => undefined }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The real sheet presents a native window; under test it only has to report
// whether the menu is open, which is what "the picker opened" means here.
vi.mock('@/components/ui/sheet', () => ({
  Sheet: (props: { visible: boolean; children: ReactNode }) => {
    h.sheetVisible = props.visible;
    return createElement('Sheet', { visible: props.visible }, props.children);
  },
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'Chevron' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#0f0', mutedForeground: '#666' }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', async () => {
  // `vi.mock` hoists this factory above the file's imports, so it cannot close
  // over one; the context it needs is built from a fresh react import.
  const { createContext: create } = await import('react');
  return { Text: 'Text', TextClassContext: create(undefined) };
});
// The detector editors have their own suite; this one reads the section around
// them, so each renders its label and its children and nothing more.
vi.mock('@/components/organization/guardrails-detector-editor', () => ({
  DetectorCard: (props: { label: string; children?: ReactNode }) =>
    createElement('DetectorCard', null, props.label, props.children),
  PolicyFormatField: 'PolicyFormatField',
  PolicyTextField: 'PolicyTextField',
}));
vi.mock('@/components/organization/guardrails-policy-rules', () => ({
  PolicyRulesEditor: 'PolicyRulesEditor',
}));

type WidgetProps = Record<string, unknown>;

type TestNode = {
  type: unknown;
  props: WidgetProps;
  children: readonly (TestNode | string)[];
  findAll(predicate: (node: TestNode) => boolean): TestNode[];
};

/** The draft the section edits: input on by default, one policy text, output off. */
function draftFor(groupId: string | null, inputEnabled = true): GuardrailsDraft {
  return {
    inputEnabled,
    groupId,
    detectors: {
      injection_attack: { enabled: true, action: 'log' },
      pii: { enabled: false, action: 'log', entities: ['secrets'] },
      keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
      topic_detector: { enabled: false, topic: [] },
      policy_violation: {
        enabled: true,
        action: 'log',
        format: 'policy_text',
        policy_text: 'Our policy.',
        rules: [],
      },
      toxicity: { enabled: false },
      nsfw: { enabled: false },
      bias: { enabled: false, action: 'log' },
      sponge_attack: { enabled: false },
    },
    outputEnabled: false,
    outputDetectors: {
      pii: { enabled: false, action: 'block', entities: ['secrets'] },
      toxicity: { enabled: false, action: 'block' },
      nsfw: { enabled: false, action: 'block' },
      bias: { enabled: false, action: 'log' },
      keyword_detector: { enabled: false, action: 'block', banned_keywords: '' },
      topic_detector: { enabled: false, action: 'block', topic: '' },
      policy_violation: {
        enabled: false,
        action: 'block',
        format: 'rules',
        policy_text: '',
        rules: [],
      },
    },
  };
}

const GROUP = { id: 'group-1', name: 'Group One' };

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

/** The pressables whose own text mentions `text`: a pressable row, if any. */
function pressableMentioning(root: TestNode, text: string): TestNode | undefined {
  return findAll(root, 'Pressable').find(candidate => textOf(candidate).includes(text));
}

/** The one pressable that renders exactly `label`, which is how an action is pressed. */
function pressableLabelled(root: TestNode, label: string): TestNode {
  const button = findAll(root, 'Pressable').find(candidate => textOf(candidate) === label);
  if (!button) {
    throw new TypeError(`no pressable labelled ${label}`);
  }
  return button;
}

function findOne(root: TestNode, type: string): TestNode {
  const [node] = findAll(root, type);
  if (!node) {
    throw new TypeError(`no ${type} node rendered`);
  }
  return node;
}

/** Every Text line the tree renders, in render order. */
function renderedText(root: TestNode): string {
  return findAll(root, 'Text')
    .map(node => textOf(node))
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function press(node: TestNode): void {
  const onPress = node.props.onPress;
  if (typeof onPress !== 'function') {
    throw new TypeError('the node has no onPress');
  }
  // A host node's props are untyped data; the row's press is what the suite
  // presses, so its shape is the one thing known here.
  const invoke = onPress as () => void;
  act(() => {
    invoke();
  });
}

const openUnmounts: (() => void)[] = [];

async function mountSection(
  draft: GuardrailsDraft,
  groups: readonly OrgGuardrailsGroup[]
): Promise<RenderWithProvidersResult['renderer']> {
  const { renderer, unmount } = await renderWithProviders(
    createElement(InputGuardrailsSection, {
      draft,
      groups,
      disabled: false,
      onChange: () => undefined,
      applyKiloDefault: h.applyKiloDefault,
    })
  );
  openUnmounts.push(unmount);
  return renderer;
}

afterEach(() => {
  for (const unmount of openUnmounts.splice(0)) {
    unmount();
  }
});

describe('InputGuardrailsSection scope row', () => {
  it('states All members without a group, as a row the reader cannot press', async () => {
    const renderer = await mountSection(draftFor(null), []);

    expect(renderedText(renderer.root)).toContain(i18n.t('organizationGuardrails.applyTo'));
    expect(renderedText(renderer.root)).toContain(
      i18n.t('organizationGuardrails.applyToAllMembers')
    );
    // No pressable row carries the scope, so no tap can open a picker with
    // nothing to choose; the disclosure glyph is gone for the same reason.
    expect(
      pressableMentioning(renderer.root, i18n.t('organizationGuardrails.applyTo'))
    ).toBeUndefined();
    expect(findAll(renderer.root, 'Chevron')).toEqual([]);
    expect(h.sheetVisible).toBe(false);
  });

  it('hides the scope row with the fields when the input guardrail is off', async () => {
    // The row lives in the section's `intro`, which renders only while the
    // section's fields do. Switching the guardrail off puts nothing in scope,
    // so the row goes with the detectors instead of claiming a scope.
    const renderer = await mountSection(draftFor(null, false), []);

    expect(renderedText(renderer.root)).not.toContain(i18n.t('organizationGuardrails.applyTo'));
    expect(renderedText(renderer.root)).not.toContain(
      i18n.t('organizationGuardrails.applyToAllMembers')
    );
  });

  it('opens the group picker from the scope row when a group exists', async () => {
    const renderer = await mountSection(draftFor(null), [GROUP]);

    const row = pressableMentioning(renderer.root, i18n.t('organizationGuardrails.applyTo'));
    if (!row) {
      throw new TypeError('the scope row is not pressable');
    }
    expect(findAll(renderer.root, 'Chevron')).toHaveLength(1);
    expect(h.sheetVisible).toBe(false);

    press(row);

    expect(h.sheetVisible).toBe(true);
    const pickerText = textOf(findOne(renderer.root, 'Sheet'));
    expect(pickerText).toContain(i18n.t('organizationGuardrails.applyToAllMembers'));
    expect(pickerText).toContain(GROUP.name);
  });
});

describe('InputGuardrailsSection apply Kilo Default', () => {
  it('says the default policy text is English and hands the preset to the form', async () => {
    h.applyKiloDefault.mockReset();
    const renderer = await mountSection(draftFor(null), []);

    expect(renderedText(renderer.root)).toContain(
      i18n.t('organizationGuardrails.applyKiloDefaultEnglishNote')
    );

    const button = pressableLabelled(
      renderer.root,
      i18n.t('organizationGuardrails.applyKiloDefault')
    );
    press(button);

    expect(h.applyKiloDefault).toHaveBeenCalledTimes(1);
    const [call] = h.applyKiloDefault.mock.calls;
    if (!call) {
      throw new TypeError('the preset was not requested');
    }
    const [afterApply] = call;
    expect(typeof afterApply).toBe('function');
    // The section no longer writes the preset itself: the form owns the write,
    // so the callback only remounts the policy field.
    expect(() => {
      afterApply();
    }).not.toThrow();
  });
});
