/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

import * as Haptics from 'expo-haptics';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type SessionAutoApproveState } from './session-auto-approve';
import { SessionAutoApproveRow } from './session-auto-approve-row';

vi.mock('react-native', () => ({
  View: 'View',
  Switch: 'Switch',
  Text: 'Text',
  I18nManager: { isRTL: false },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderRow(state: SessionAutoApproveState, onValueChange: (value: boolean) => void) {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionAutoApproveRow, { state, onValueChange })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function switchNodes(root: I): I[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'Switch');
}

function switchProps(root: I): { value: boolean; disabled: boolean } {
  const node = switchNodes(root)[0];
  if (!node) {
    throw new Error('Switch was not rendered');
  }
  return { value: node.props.value as boolean, disabled: node.props.disabled as boolean };
}

function renderedTexts(root: I): string[] {
  return root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    )
    .map(node => node.props.children as string);
}

describe('SessionAutoApproveRow', () => {
  it('renders the title, the on switch, and the warning copy for state=on', () => {
    const root = renderRow('on', vi.fn<(value: boolean) => void>());

    expect(
      root.root.findAll(node => node.props.testID === 'session-auto-approve-row')
    ).toHaveLength(1);
    expect(switchProps(root.root)).toEqual({ value: true, disabled: false });
    expect(renderedTexts(root.root)).toContain('Auto-approve');
    expect(renderedTexts(root.root)).toContain(
      'Approve permission asks for this session automatically. Tools then run without a prompt.'
    );
  });

  it('renders the off switch with the warning copy for state=off', () => {
    const root = renderRow('off', vi.fn<(value: boolean) => void>());

    expect(switchProps(root.root)).toEqual({ value: false, disabled: false });
    expect(renderedTexts(root.root)).toContain(
      'Approve permission asks for this session automatically. Tools then run without a prompt.'
    );
  });

  it('disables the switch and shows the unavailable copy for state=unavailable', () => {
    const root = renderRow('unavailable', vi.fn<(value: boolean) => void>());

    expect(switchProps(root.root)).toEqual({ value: false, disabled: true });
    expect(renderedTexts(root.root)).toContain('This session cannot receive permission asks.');
    expect(renderedTexts(root.root)).not.toContain(
      'Approve permission asks for this session automatically. Tools then run without a prompt.'
    );
  });

  it('forwards the next value and fires a selection haptic on change', () => {
    const onValueChange = vi.fn<(value: boolean) => void>();
    const root = renderRow('off', onValueChange);

    const switchNode = switchNodes(root.root)[0];
    if (!switchNode) {
      throw new Error('Switch was not rendered');
    }
    act(() => {
      (switchNode.props.onValueChange as (next: boolean) => void)(true);
    });

    expect(onValueChange).toHaveBeenCalledWith(true);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });
});
