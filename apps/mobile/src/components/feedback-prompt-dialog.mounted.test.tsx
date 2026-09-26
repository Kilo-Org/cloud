/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native assertions. */
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { FeedbackPromptDialog } from './feedback-prompt-dialog';

const feedback = vi.hoisted(() => ({
  requestAppRating: vi.fn(),
  sendAppFeedback: vi.fn(),
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructiveForeground: '#FFFFFF',
    foreground: '#1A1A10',
    primary: '#00BAA9',
    primaryForeground: '#FFFFFF',
  }),
}));
// The dialog owns the actions, so the module under test is the real dialog; the
// feedback module is the boundary that decides what each answer does.
vi.mock('@/lib/feedback', () => feedback);
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

const TITLE = 'feedback.neutralTitle';
const RATE = 'feedback.rateTheApp';
const SEND = 'feedback.sendFeedback';
const NOT_NOW = 'common.notNow';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

const onDismiss = vi.fn<() => void>();

function mount() {
  act(() => {
    const element = createElement(FeedbackPromptDialog, { userId: 'user-1', onDismiss });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing FeedbackPromptDialog renderer');
  }
  return renderer.root;
}

function classNameOf(node: TestRenderer.ReactTestInstance): string {
  return typeof node.props.className === 'string' ? node.props.className : '';
}

function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

/** The control carrying `token` in its variant classes (the library's fills). */
function pressableWith(root: TestRenderer.ReactTestInstance, token: string) {
  return root.find(node => isType(node, 'Pressable') && classNameOf(node).includes(token));
}

function press(node: TestRenderer.ReactTestInstance) {
  act(() => {
    (node.props as { onPress?: () => void }).onPress?.();
  });
}

beforeEach(() => {
  onDismiss.mockReset();
  feedback.requestAppRating.mockReset();
  feedback.sendAppFeedback.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('FeedbackPromptDialog', () => {
  // The finding's defect is the Android alert's empty message band: a title at
  // the top, a large void, and the actions adrift at the bottom. The in-app
  // dialog lays the title out against the three answers instead.
  it('renders the prompt title with one control per answer', () => {
    const root = mount();

    expect(
      root.findAll(node => isType(node, 'Text') && node.children.includes(TITLE))
    ).toHaveLength(1);
    for (const token of ['bg-primary', 'border-border', 'active:opacity-60']) {
      expect(
        root.findAll(node => isType(node, 'Pressable') && classNameOf(node).includes(token))
      ).toHaveLength(1);
    }
  });

  it('labels the three answers with the prompt copy', () => {
    const root = mount();

    for (const label of [RATE, SEND, NOT_NOW]) {
      expect(
        root.findAll(node => isType(node, 'Text') && node.children.includes(label))
      ).toHaveLength(1);
    }
    expect(
      pressableWith(root, 'bg-primary').findAll(
        node => isType(node, 'Text') && node.children.includes(RATE)
      )
    ).toHaveLength(1);
    expect(
      pressableWith(root, 'border-border').findAll(
        node => isType(node, 'Text') && node.children.includes(SEND)
      )
    ).toHaveLength(1);
    expect(
      pressableWith(root, 'active:opacity-60').findAll(
        node => isType(node, 'Text') && node.children.includes(NOT_NOW)
      )
    ).toHaveLength(1);
  });

  it('records the positive answer and dismisses when Rate is pressed', () => {
    const root = mount();

    press(pressableWith(root, 'bg-primary'));

    expect(feedback.requestAppRating).toHaveBeenCalledTimes(1);
    expect(feedback.sendAppFeedback).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('records the negative answer with the user id and dismisses when Send is pressed', () => {
    const root = mount();

    press(pressableWith(root, 'border-border'));

    expect(feedback.sendAppFeedback).toHaveBeenCalledWith('user-1');
    expect(feedback.requestAppRating).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses and records nothing when Not now is pressed', () => {
    const root = mount();

    press(pressableWith(root, 'active:opacity-60'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(feedback.requestAppRating).not.toHaveBeenCalled();
    expect(feedback.sendAppFeedback).not.toHaveBeenCalled();
  });

  it('dismisses without recording on the Android back request', () => {
    const root = mount();

    act(() => {
      (
        root.find(node => isType(node, 'Modal')).props as { onRequestClose?: () => void }
      ).onRequestClose?.();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(feedback.requestAppRating).not.toHaveBeenCalled();
    expect(feedback.sendAppFeedback).not.toHaveBeenCalled();
  });
});
