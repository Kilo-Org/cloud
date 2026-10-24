import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { PermissionUnreadableNotice } from './permission-unreadable-notice';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return { ...actual, useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }) };
});
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

async function renderNotice() {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await vi.waitFor(() => {
      expect(i18n.t('agentChat.permissionCard.unreadableTitle')).toBe(
        'Permission request could not be read'
      );
    });
    rendererRef.current = TestRenderer.create(createElement(PermissionUnreadableNotice));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('PermissionUnreadableNotice mounted', () => {
  it('explains that the request cannot be shown and points at the CLI', async () => {
    const renderer = await renderNotice();

    const text = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string)
      .join(' ');

    expect(text).toContain('Permission request could not be read');
    expect(text).toContain('The agent is waiting for a permission decision this app cannot show.');
    expect(text).toContain('answer the request in the CLI');
  });

  it('carries the notice as an alert and renders no decision action', async () => {
    const renderer = await renderNotice();

    const alerts = renderer.root.findAll(node => node.props.accessibilityRole === 'alert');
    expect(alerts).toHaveLength(1);
    expect(
      renderer.root.findAll(node => node.props.accessibilityRole === 'button')
    ).toHaveLength(0);
  });
});
