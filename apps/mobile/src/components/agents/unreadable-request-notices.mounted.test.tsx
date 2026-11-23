import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { UnreadableRequestNotices } from './unreadable-request-notices';

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

async function renderNotices(props: { hasQuestions: boolean; hasPermissions: boolean }) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await vi.waitFor(() => {
      expect(i18n.t('agentChat.permissionCard.unreadableTitle')).toBe(
        'Permission request could not be read'
      );
      expect(i18n.t('agentChat.questionCard.unreadableTitle')).toBe(
        'This question could not be displayed'
      );
    });
    announceForA11y.mockClear();
    rendererRef.current = TestRenderer.create(createElement(UnreadableRequestNotices, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('UnreadableRequestNotices mounted', () => {
  it('shows both notices on Android without announcing them', async () => {
    platform.os = 'android';
    const renderer = await renderNotices({ hasQuestions: true, hasPermissions: true });

    const text = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string)
      .join(' ');
    expect(text).toContain('Permission request could not be read');
    expect(text).toContain('This question could not be displayed');
    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it('announces both bodies as one message on iOS, permission first', async () => {
    platform.os = 'ios';
    const renderer = await renderNotices({ hasQuestions: true, hasPermissions: true });

    const text = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string)
      .join(' ');
    expect(text).toContain('This question could not be displayed');
    expect(announceForA11y).toHaveBeenCalledTimes(1);
    expect(announceForA11y).toHaveBeenCalledWith(
      `${i18n.t('agentChat.permissionCard.unreadableBody')} ${i18n.t('agentChat.questionCard.unreadableBody')}`
    );
  });

  it('announces only the question body on iOS when it is the only notice', async () => {
    platform.os = 'ios';
    await renderNotices({ hasQuestions: true, hasPermissions: false });

    expect(announceForA11y).toHaveBeenCalledTimes(1);
    expect(announceForA11y).toHaveBeenCalledWith(i18n.t('agentChat.questionCard.unreadableBody'));
  });

  it('announces nothing again when one of two notices resolves on iOS', async () => {
    platform.os = 'ios';
    const renderer = await renderNotices({ hasQuestions: true, hasPermissions: true });

    expect(announceForA11y).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(
        createElement(UnreadableRequestNotices, { hasQuestions: true, hasPermissions: false })
      );
    });
    expect(announceForA11y).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(
        createElement(UnreadableRequestNotices, { hasQuestions: false, hasPermissions: false })
      );
    });
    expect(announceForA11y).toHaveBeenCalledTimes(1);
  });

  it('draws nothing and announces nothing when no request is unreadable', async () => {
    platform.os = 'ios';
    const renderer = await renderNotices({ hasQuestions: false, hasPermissions: false });

    expect(renderer.toJSON()).toBeNull();
    expect(renderer.root.findAll(node => node.props.accessibilityRole === 'alert')).toHaveLength(0);
    expect(announceForA11y).not.toHaveBeenCalled();
  });
});
