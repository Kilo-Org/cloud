import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { OrganizationPlanRefusal } from './plan-refusal';
import { OrganizationPlanNotice } from './plan-notice';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
// The state action is asserted through its props, so a host element of the same
// name stands in for it.
vi.mock('@/components/empty-state', () => ({ StateAction: 'StateAction' }));
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle', CreditCard: 'CreditCard' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#ff0000' }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderBlock(props: { action?: { label: string; onPress: () => void } }) {
  act(() => {
    const element = createElement(OrganizationPlanRefusal, { message: 'Trial ended.', ...props });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing refusal renderer');
  }
  return renderer.root;
}

function renderNotice(props: {
  title?: string;
  message?: string;
  action?: { label: string; onPress: () => void };
}) {
  act(() => {
    const element = createElement(OrganizationPlanNotice, {
      title: 'Plan required',
      message: 'Trial ended.',
      ...props,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing notice renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('OrganizationPlanRefusal', () => {
  it('states the explanation as an error and offers nothing without an action', () => {
    const root = renderBlock({});

    expect(root.findByType('AccessibleStatus').props).toMatchObject({
      message: 'Trial ended.',
      tone: 'error',
    });
    expect(root.findAllByType('Pressable')).toHaveLength(0);
  });

  it('renders the action on its own target and presses it', () => {
    const onPress = vi.fn<() => void>();
    const root = renderBlock({ action: { label: 'Manage billing', onPress } });

    const [control] = root.findAllByType('Pressable');
    if (!control) {
      throw new Error('action control not found');
    }
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('Manage billing');
    // The action reads as one line of copy under the message: its visible box
    // is the control-size audit's floor plus the label line, and `hitSlop`
    // carries the design target, so the tile's own padding stays symmetric.
    expect(control.props.className).toContain('min-h-[32px]');
    expect(control.props.className).not.toContain('min-h-[48px]');
    expect(control.props.hitSlop).toEqual({ top: 9, bottom: 9, left: 5, right: 5 });
    const label = root.findByType('Text');
    expect(label.props.children).toBe('Manage billing');
    // The brand primary is off-palette on the error-tinted surface (olive in
    // light, saturated yellow in dark), so the action wears the message's ink
    // and marks itself as the action by its underline instead of by hue.
    expect(label.props.className).toContain('text-destructive');
    expect(label.props.className).toContain('underline');
    expect(label.props.className).not.toContain('text-primary');

    act(() => {
      (control.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('OrganizationPlanNotice', () => {
  it('titles the state above the explanation, in the warning ink on the title only', () => {
    const root = renderNotice({});

    const texts = root.findAllByType('Text');
    const title = texts.find(node => node.props.children === 'Plan required');
    const message = texts.find(node => node.props.children === 'Trial ended.');
    if (!title || !message) {
      throw new Error('the notice did not paint its title and message');
    }
    expect(title).not.toBe(message);
    expect(title.props.className).toContain('text-destructive');
    // Red belongs to the mark and the title; the explanation keeps the muted
    // body ink, which is what stays readable on this tint in both schemes.
    expect(message.props.className).not.toContain('text-destructive');
    expect(message.props.className).toContain('text-ink2');
    expect(root.findAllByType('AccessibleStatus')).toHaveLength(0);
  });

  it('offers the billing step as the state action, and nothing without one', () => {
    const withoutAction = renderNotice({});
    expect(withoutAction.findAllByType('StateAction')).toHaveLength(0);

    const onPress = vi.fn<() => void>();
    const root = renderNotice({ action: { label: 'Manage billing', onPress } });

    const [action] = root.findAllByType('StateAction');
    if (!action) {
      throw new Error('the notice rendered no state action');
    }
    expect(action.props.label).toBe('Manage billing');
    expect(action.props.icon).toBe('CreditCard');
    // The state's only control: the quiet face would understate the one way out.
    expect(action.props.emphasis).toBe('primary');

    act(() => {
      (action.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
