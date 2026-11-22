import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { QuestionUnreadableNotice } from './question-unreadable-notice';

const platform = vi.hoisted(() => ({ os: 'android' as string }));
const announceForA11y = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return { ...actual, useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }) };
});
vi.mock('react-native', () => ({
  View: 'View',
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

async function renderNotice(props: { inset?: boolean } = {}) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await vi.waitFor(() => {
      expect(i18n.t('agentChat.questionCard.unreadableTitle')).toBe(
        'This question could not be displayed'
      );
    });
    rendererRef.current = TestRenderer.create(createElement(QuestionUnreadableNotice, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('QuestionUnreadableNotice mounted', () => {
  it('explains that the question cannot be shown and points at the CLI', async () => {
    const renderer = await renderNotice();

    const text = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string)
      .join(' ');

    expect(text).toContain('This question could not be displayed');
    expect(text).toContain('waiting on a question this app cannot show');
    expect(text).toContain('Answer the question in the CLI');
  });

  it('carries the notice as an alert and renders no answer action', async () => {
    const renderer = await renderNotice();

    const alerts = renderer.root.findAll(node => node.props.accessibilityRole === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.props.accessibilityLiveRegion).toBe('polite');
    expect(renderer.root.findAll(node => node.props.accessibilityRole === 'button')).toHaveLength(
      0
    );
  });

  it('insets itself by default and drops the margin when the container already insets', async () => {
    const defaultNotice = await renderNotice();
    const insetNotice = await renderNotice({ inset: true });
    const flushNotice = await renderNotice({ inset: false });

    const classNameOf = (renderer: TestRenderer.ReactTestRenderer) => {
      const alert = renderer.root.findAll(node => node.props.accessibilityRole === 'alert')[0];
      return alert?.props.className as string;
    };

    expect(classNameOf(defaultNotice)).toContain('mx-4');
    expect(classNameOf(insetNotice)).toContain('mx-4');
    expect(classNameOf(flushNotice)).not.toContain('mx-4');
  });

  it('lets Android read the live region instead of announcing as well', async () => {
    platform.os = 'android';
    announceForA11y.mockClear();
    await renderNotice();

    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it('announces once on iOS, which has no live region', async () => {
    platform.os = 'ios';
    announceForA11y.mockClear();
    await renderNotice();

    expect(announceForA11y).toHaveBeenCalledTimes(1);
    expect(announceForA11y).toHaveBeenCalledWith(
      'The agent is waiting on a question this app cannot show, so no answer card appears for it. Answer the question in the CLI to continue.'
    );
  });
});
