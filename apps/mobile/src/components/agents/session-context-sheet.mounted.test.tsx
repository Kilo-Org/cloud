/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { type SessionAutoApproveState } from './session-auto-approve';
import { SessionContextSheet } from './session-context-sheet';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-svg', () => ({ Circle: 'Circle', default: 'Svg' }));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('./session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    hairSoft: '#eeeeee',
    mutedForeground: '#666666',
  }),
}));

const WARNING_COPY =
  'Approve permission asks for this session automatically. Tools then run without a prompt.';
const UNAVAILABLE_COPY = 'This session cannot receive permission asks.';

const INFO: SessionContextInfo = {
  contextTokens: 1000,
  providerID: 'kilo',
  modelID: 'model-x',
  contextWindow: 10_000,
  percentage: 10,
};

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function renderSheet(
  state: SessionAutoApproveState,
  onAutoApproveChange: (enabled: boolean) => void = vi.fn<(enabled: boolean) => void>(),
  overrides: Partial<ComponentProps<typeof SessionContextSheet>> = {}
) {
  const ref: { current: Renderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionContextSheet, {
        visible: true,
        info: INFO,
        modelDisplay: 'Model X',
        providerDisplay: 'Kilo',
        totalCostMicrodollars: null,
        breakdownCostUsd: 0,
        messages: [],
        modelOptions: [],
        autoApproveState: state,
        onAutoApproveChange,
        onClose: vi.fn<() => void>(),
        ...overrides,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findByTestID(root: Instance, testID: string): Instance[] {
  return root.findAll(node => node.props.testID === testID);
}

function indexOfTestID(root: Instance, testID: string): number {
  return root.findAll(() => true).findIndex(node => node.props.testID === testID);
}

function indexOfType(root: Instance, type: string): number {
  return root
    .findAll(() => true)
    .findIndex(node => typeof node.type === 'string' && (node.type as string) === type);
}

function findByType(root: Instance, type: string): Instance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function switchNode(root: Instance): Instance {
  const found = findByTestID(root, 'session-auto-approve-switch');
  if (!found[0]) {
    throw new Error('switch was not rendered');
  }
  return found[0];
}

function renderedTexts(root: Instance): string[] {
  return findByType(root, 'Text').flatMap(node =>
    node.children.filter((child): child is string => typeof child === 'string')
  );
}

describe('SessionContextSheet auto-approve row', () => {
  it.each(['on', 'off', 'unavailable'] as const)(
    'renders %s controls without usage and reserves the detail rows as usage arrives',
    state => {
      const renderer = renderSheet(state, vi.fn<(enabled: boolean) => void>(), {
        info: undefined,
        modelDisplay: '',
        providerDisplay: '',
      });
      const sheet = renderer.root.findByType(SessionContextSheet);
      const props = sheet.props as ComponentProps<typeof SessionContextSheet>;
      const switchBefore = switchNode(renderer.root);
      expect(switchBefore.props.value).toBe(state === 'on');
      expect(switchBefore.props.disabled).toBe(state === 'unavailable');
      expect(renderedTexts(renderer.root)).toContain('-');
      expect(renderedTexts(renderer.root)).not.toContain('1,000');
      const labels = [
        i18n.t('common.model'),
        i18n.t('agentChat.contextUsage.provider'),
        ...(state === 'unavailable'
          ? []
          : [i18n.t('common.remaining'), i18n.t('agentChat.contextUsage.totalCost')]),
      ];
      for (const label of labels) {
        expect(renderedTexts(renderer.root)).toContain(label);
      }
      act(() => {
        renderer.update(
          createElement(SessionContextSheet, {
            ...props,
            info: INFO,
            modelDisplay: 'Model X',
            providerDisplay: 'Kilo',
          })
        );
      });
      expect(switchNode(renderer.root)).toBe(switchBefore);
      expect(renderedTexts(renderer.root)).toContain('1,000');
      for (const label of labels) {
        expect(renderedTexts(renderer.root)).toContain(label);
      }
      act(() => {
        renderer.unmount();
      });
    }
  );

  it('renders the auto-approve row first in the sheet body, above the scrolling details', () => {
    const renderer = renderSheet('on');
    const root = renderer.root;

    const rowIndex = indexOfTestID(root, 'session-auto-approve-row');
    const ringIndex = indexOfTestID(root, 'session-context-sheet-ring');
    const headerIndex = indexOfType(root, 'SheetHeader');

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(ringIndex).toBeGreaterThanOrEqual(0);
    // The header title ("Context usage") is above the row; the row is the
    // first body element and precedes the usage ring inside the ScrollView.
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(headerIndex).toBeLessThan(rowIndex);
    expect(rowIndex).toBeLessThan(ringIndex);

    // Outside the ScrollView, so it never scrolls away with the details.
    const scrollView = findByType(root, 'ScrollView')[0];
    expect(scrollView).toBeDefined();
    expect(
      scrollView?.findAll(node => node.props.testID === 'session-auto-approve-row')
    ).toHaveLength(0);

    renderer.unmount();
  });

  it.each([
    { state: 'on' as const, copy: WARNING_COPY, value: true, disabled: false },
    { state: 'off' as const, copy: WARNING_COPY, value: false, disabled: false },
    { state: 'unavailable' as const, copy: UNAVAILABLE_COPY, value: false, disabled: true },
  ])(
    'renders the $state row with its copy and switch state',
    ({ state, copy, value, disabled }) => {
      const renderer = renderSheet(state);

      expect(findByTestID(renderer.root, 'session-auto-approve-row')).toHaveLength(1);
      expect(renderedTexts(renderer.root)).toContain('Auto-approve');
      expect(renderedTexts(renderer.root)).toContain(copy);
      if (state === 'unavailable') {
        expect(renderedTexts(renderer.root)).not.toContain(WARNING_COPY);
      }
      expect(switchNode(renderer.root).props.value).toBe(value);
      expect(switchNode(renderer.root).props.disabled).toBe(disabled);

      renderer.unmount();
    }
  );

  it('forwards the next switch value to the change handler', () => {
    const onAutoApproveChange = vi.fn<(enabled: boolean) => void>();
    const renderer = renderSheet('off', onAutoApproveChange);

    act(() => {
      (switchNode(renderer.root).props.onValueChange as (next: boolean) => void)(true);
    });

    expect(onAutoApproveChange).toHaveBeenCalledWith(true);
    renderer.unmount();
  });
});
