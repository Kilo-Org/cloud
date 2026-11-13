import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AGENTS_SESSIONS_INDEX_HREF } from '@/lib/agents-sessions-route';
import { i18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/query-error';
import { SessionPermanentError } from './session-permanent-error';
import { Text } from '@/components/ui/text';

const router = vi.hoisted(() => ({ dismissTo: vi.fn() }));
const copy = vi.hoisted(() => ({ performCopy: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('./use-message-copy', () => ({ performCopy: copy.performCopy }));
vi.mock('./restored-route-fallback', () => ({ RestoredRouteFallback: 'RestoredRouteFallback' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('react-native', () => ({ View: 'View' }));

function mountCard(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionPermanentError, {
        variant: 'not-found',
        title: 'Session not found',
        message: 'This session is no longer available.',
        isRetrying: false,
        copyText: 'ses_test not-found',
        restoredRouteOpen: false,
      })
    );
  });
  if (!ref.current) {
    throw new Error('the terminal card did not mount');
  }
  return ref.current;
}

describe('SessionPermanentError actions', () => {
  it('fills Back with the muted dark tone, keeps Copy outlined, and returns to the sessions index', () => {
    const renderer = mountCard();
    const root = renderer.root;

    expect(root.findAllByType(QueryError)).toHaveLength(1);

    const buttons = root.findAllByType(Button);
    const back = buttons.find(
      button =>
        button.findByType(Text).props.children === i18n.t('agentChat.session.backToSessions')
    );
    const copyButton = buttons.find(
      button => button.findByType(Text).props.children === i18n.t('common.copy')
    );
    if (!back || !copyButton) {
      throw new Error('the terminal card is missing one of its actions');
    }

    // Dark --primary is the brand yellow that glares on the near-black page, so dark takes the muted lifted olive.
    expect(String(back.props.className)).toContain('bg-primary');
    expect(String(back.props.className)).toContain('dark:bg-selection');
    const backLabel = back.findByType(Text);
    expect(String(backLabel.props.className)).toContain('text-primary-foreground');
    expect(String(backLabel.props.className)).toContain('dark:text-selection-foreground');

    expect(copyButton.props.variant).toBe('outline');
    expect(String(copyButton.props.className)).not.toContain('dark:bg-selection');

    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(router.dismissTo).toHaveBeenCalledWith(AGENTS_SESSIONS_INDEX_HREF);
  });
});
