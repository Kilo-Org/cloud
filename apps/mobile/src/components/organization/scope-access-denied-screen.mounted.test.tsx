// The no-access surface is the product landings' shared state for an
// organization the reader may not see. It must say access is lost (or the
// organization is gone), and offer both recoveries: a Retry that re-resolves
// the membership and a way back to Profile that drops the stale selection.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ScopeAccessDeniedScreen } from './scope-access-denied-screen';

const replaceMock = vi.hoisted(() => vi.fn());
const retryMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; eyebrow?: string }) =>
    createElement('ScreenHeaderMock', { title: props.title, eyebrow: props.eyebrow }),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    message?: string;
    action?: ReactNode;
    onRetry?: () => void;
  }) =>
    createElement(
      'QueryErrorMock',
      { variant: props.variant, message: props.message },
      props.action ?? (props.onRetry ? 'BUILT_IN_RETRY' : null)
    ),
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: { onPress?: () => void; children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('ButtonMock', { onPress: props.onPress }, [
      createElement('ButtonLabelMock', { label: props.accessibilityLabel }),
      props.children,
    ]),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

vi.mock('react-native', () => ({ View: 'View' }));

const Denied = ScopeAccessDeniedScreen as ComponentType<{
  title: string;
  eyebrow?: string;
  kind: 'denied' | 'not-found';
  onRetry: () => void;
  isRetrying?: boolean;
}>;

function mountScreen(props: {
  title?: string;
  eyebrow?: string;
  kind?: 'denied' | 'not-found';
  isRetrying?: boolean;
}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(Denied, {
        title: props.title ?? 'Security Agent',
        eyebrow: props.eyebrow,
        kind: props.kind ?? 'denied',
        onRetry: () => {
          retryMock();
        },
        isRetrying: props.isRetrying,
      })
    );
  });
  if (!ref.current) {
    throw new Error('denied screen did not render');
  }
  return ref.current;
}

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function button(label: string, root: TestRenderer.ReactTestInstance) {
  return findByType(root, 'ButtonMock').find(
    node =>
      findByType(node, 'ButtonLabelMock')[0]?.props.label === label
  );
}

function press(target: TestRenderer.ReactTestInstance | undefined) {
  if (!target) {
    throw new Error('the requested button was not rendered');
  }
  act(() => {
    (target.props.onPress as () => void)();
  });
}

beforeEach(() => {
  replaceMock.mockReset();
  retryMock.mockReset();
});

describe('ScopeAccessDeniedScreen', () => {
  it('states that access was lost and offers Retry plus Back to profile', () => {
    const renderer = mountScreen({});
    const error = findByType(renderer.root, 'QueryErrorMock')[0];

    expect(error?.props.variant).toBe('permission');
    expect(error?.props.message).toBe('You do not have access to this organization.');
    expect(button('Retry', renderer.root)).toBeDefined();
    expect(button('Back to profile', renderer.root)).toBeDefined();
    expect(findByType(renderer.root, 'ScreenHeaderMock')[0]?.props.title).toBe('Security Agent');

    act(() => {
      renderer.unmount();
    });
  });

  it('calls Retry in place', () => {
    const renderer = mountScreen({});
    press(button('Retry', renderer.root));

    expect(retryMock).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('replaces the stale selection with the Profile tab', () => {
    const renderer = mountScreen({});
    press(button('Back to profile', renderer.root));

    expect(replaceMock).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');

    act(() => {
      renderer.unmount();
    });
  });

  it('uses the unavailable copy for an organization that no longer exists', () => {
    const renderer = mountScreen({ kind: 'not-found', eyebrow: 'Code Reviewer' });
    const error = findByType(renderer.root, 'QueryErrorMock')[0];

    expect(error?.props.variant).toBe('not-found');
    expect(error?.props.message).toBe(
      'This organization is no longer available. Choose another account from the account picker to continue.'
    );
    expect(findByType(renderer.root, 'ScreenHeaderMock')[0]?.props.eyebrow).toBe('Code Reviewer');

    act(() => {
      renderer.unmount();
    });
  });
});
