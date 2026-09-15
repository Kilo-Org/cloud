import { describe, expect, it, vi } from 'vitest';

import { type CloudCreateFailure } from '@/components/agents/use-new-session-creator';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('react-native', () => ({ View: 'View' }));

vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));

type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function findElementsOfType(node: Node, typeName: string): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  const here = type === typeName ? [props] : [];
  const childrenList = Array.isArray(children) ? children : [children];
  return [...here, ...childrenList.flatMap(child => findElementsOfType(child as Node, typeName))];
}

function findElementByType(node: Node, typeName: string): Record<string, unknown> | null {
  return findElementsOfType(node, typeName)[0] ?? null;
}

const GENERIC = 'Failed to create session';
// A retryable server reason that is deliberately not the generic copy: with the
// generic copy the assertion below would pass even if the suppression were
// keyed on the message text instead of on `retryable`.
const RETRYABLE_REASON = 'The agent is still starting up';

function failure(over: Partial<CloudCreateFailure>): CloudCreateFailure {
  return { retryable: false, message: GENERIC, ...over };
}

function messages(node: Node): string[] {
  return findElementsOfType(node, 'AccessibleStatus')
    .map(props => props.message)
    .filter((message): message is string => typeof message === 'string');
}

describe('NewSessionCloudCreateError', () => {
  it('always reports the failure in the form voice', async () => {
    const { NewSessionCloudCreateError } = await import('./new-session-cloud-create-error');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudCreateError({
      failure: failure({}),
      onRetry: vi.fn<() => void>(),
      isRetryDisabled: false,
    }) as Node;

    expect(messages(element)).toEqual([GENERIC]);
  });

  it('offers the retry control for a retryable rejection wired to the same submit path', async () => {
    const { NewSessionCloudCreateError } = await import('./new-session-cloud-create-error');
    const onRetry = vi.fn<() => void>();

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudCreateError({
      failure: failure({ retryable: true, message: RETRYABLE_REASON }),
      onRetry,
      isRetryDisabled: false,
    }) as Node;

    const button = findElementByType(element, 'Button');
    expect(button).toMatchObject({
      onPress: onRetry,
      disabled: false,
      accessibilityLabel: 'Retry',
    });
    // A retryable rejection speaks through the retry control, not a second
    // copy of the server message: the distinct `RETRYABLE_REASON` never renders.
    expect(messages(element)).toEqual([GENERIC]);
  });

  it('disables the retry control while Start itself is blocked', async () => {
    const { NewSessionCloudCreateError } = await import('./new-session-cloud-create-error');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudCreateError({
      failure: failure({ retryable: true }),
      onRetry: vi.fn<() => void>(),
      isRetryDisabled: true,
    }) as Node;

    expect(findElementByType(element, 'Button')?.disabled).toBe(true);
  });

  it('reports the server reason verbatim for a terminal rejection, with no retry', async () => {
    const { NewSessionCloudCreateError } = await import('./new-session-cloud-create-error');
    const reason = 'Insufficient credits for this session';

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudCreateError({
      failure: failure({ message: reason }),
      onRetry: vi.fn<() => void>(),
      isRetryDisabled: false,
    }) as Node;

    expect(messages(element)).toEqual([GENERIC, reason]);
    expect(findElementByType(element, 'Button')).toBeNull();
  });

  it('hides the server line when it repeats the generic copy', async () => {
    const { NewSessionCloudCreateError } = await import('./new-session-cloud-create-error');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionCloudCreateError({
      failure: failure({}),
      onRetry: vi.fn<() => void>(),
      isRetryDisabled: false,
    }) as Node;

    expect(messages(element)).toEqual([GENERIC]);
    expect(findElementByType(element, 'Button')).toBeNull();
  });
});
