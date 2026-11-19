// The no-access surface is the product landings' shared state for an
// organization the reader may not see. It must say who can grant access (or
// that the organization is gone), and offer both recoveries: a Retry that
// re-resolves the membership and a way back to Profile that drops the stale
// selection.

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
    descriptionClassName?: string;
    action?: ReactNode;
    onRetry?: () => void;
  }) =>
    createElement('QueryErrorMock', { variant: props.variant }, [
      // The description's own node, carrying the class list the real state
      // composes: the shared measure plus whatever cap the caller adds.
      createElement('QueryErrorMessageMock', {
        className: `text-center text-sm ${props.descriptionClassName ?? ''}`,
        message: props.message,
      }),
      props.action ?? (props.onRetry ? 'BUILT_IN_RETRY' : null),
    ]),
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: {
    onPress?: () => void;
    children?: ReactNode;
    accessibilityLabel?: string;
    variant?: string;
    className?: string;
  }) =>
    createElement('ButtonMock', { ...props }, [
      createElement('ButtonLabelMock', { label: props.accessibilityLabel }),
      props.children,
    ]),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode; className?: string }) =>
    createElement('TextMock', { className: props.className }, props.children),
}));

vi.mock('react-native', () => ({ View: 'View', useColorScheme: () => 'light' }));

// The centered state's geometry hook reports through `@sentry/react-native`,
// whose real module loads react-native in Node; the reporter is stubbed here.
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

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
    node => findByType(node, 'ButtonLabelMock')[0]?.props.label === label
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
  it('states who can grant access and leads with Back to profile', () => {
    const renderer = mountScreen({});
    const error = findByType(renderer.root, 'QueryErrorMock')[0];
    const description = error ? findByType(error, 'QueryErrorMessageMock')[0] : undefined;

    expect(error?.props.variant).toBe('permission');
    expect(description?.props.message).toBe(
      'Ask an organization owner or admin to grant you access.'
    );
    const back = button('Back to profile', renderer.root);
    const retry = button('Retry', renderer.root);
    expect(back).toBeDefined();
    expect(retry).toBeDefined();

    // Leaving the stale selection is the recovery this state leads with, so
    // Back to profile comes first. Both ways out share the one state-action
    // shape, so neither is an outlined or shadowed second control.
    const actions = findByType(renderer.root, 'ButtonMock');
    expect(actions).toHaveLength(2);
    expect(actions[0]).toBe(back);
    expect(actions[1]).toBe(retry);
    expect(back?.props.className).toBe(retry?.props.className);
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
    const description = error ? findByType(error, 'QueryErrorMessageMock')[0] : undefined;
    expect(description?.props.message).toBe(
      'This organization is no longer available. Choose another account from the account picker to continue.'
    );
    expect(findByType(renderer.root, 'ScreenHeaderMock')[0]?.props.eyebrow).toBe('Code Reviewer');
    // A deleted organization does not come back by retrying either, so the
    // order is the denied state's, with Back to profile first.
    const [backAction, retryAction] = findByType(renderer.root, 'ButtonMock');
    expect(backAction).toBe(button('Back to profile', renderer.root));
    expect(retryAction).toBe(button('Retry', renderer.root));

    act(() => {
      renderer.unmount();
    });
  });
});
