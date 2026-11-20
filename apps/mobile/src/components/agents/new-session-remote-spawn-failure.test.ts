import { describe, expect, it, vi } from 'vitest';

import { type RemoteSpawnFailure } from '@/components/agents/use-remote-spawn-dispatch-types';
import { NewSessionRemoteSpawnFailure } from '@/components/agents/new-session-remote-spawn-failure';
import { RefusalStatus } from '@/components/refusal-status';
import { type TrialRefusalAction } from '@/lib/trial-refusal';

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

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));

vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));

type Node =
  | { props?: Record<string, unknown>; type?: unknown }
  | null
  | undefined
  | string
  | number
  | boolean;

function childNodes(props: Record<string, unknown> | undefined): Node[] {
  const children = props?.children;
  return Array.isArray(children) ? (children as Node[]) : [children as Node];
}

function findPropsByType(node: Node, typeName: string): Record<string, unknown>[] {
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const props = node.props ?? {};
  const here = node.type === typeName ? [props] : [];
  return [...here, ...childNodes(props).flatMap(child => findPropsByType(child, typeName))];
}

function findPropsByComponent(node: Node, component: unknown): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  if (node.type === component) {
    return props;
  }
  for (const child of childNodes(props)) {
    const found = findPropsByComponent(child, component);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

const BILLING_COPY =
  "The organization's trial has ended and it has no active plan. You can update billing, then try again.";
const MEMBER_COPY =
  "The organization's trial has ended and it has no active plan. An organization owner can update billing at kilo.ai, then try again.";

const onPress = vi.fn<() => void>();
const BILLING_STEP: TrialRefusalAction = { label: 'Manage billing', onPress };

function renderFailure(failure: RemoteSpawnFailure, onRetry?: () => void): Node {
  // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
  return NewSessionRemoteSpawnFailure({ failure, onRetry, isRetryDisabled: false }) as Node;
}

describe('NewSessionRemoteSpawnFailure', () => {
  it('hands the plan refusal and its step to the inline status line', () => {
    const element = renderFailure({
      retryable: false,
      message: BILLING_COPY,
      action: BILLING_STEP,
    });

    // The form's inline status owns the sentence and the step: the failure only
    // decides which of them exist for this reader.
    expect(findPropsByComponent(element, RefusalStatus)).toMatchObject({
      message: BILLING_COPY,
      action: BILLING_STEP,
    });
    // A terminal refusal carries no retry control.
    expect(findPropsByType(element, 'Button')).toHaveLength(0);
  });

  it('renders a member refusal as the copy alone', () => {
    const element = renderFailure({ retryable: false, message: MEMBER_COPY });

    expect(findPropsByComponent(element, RefusalStatus)).toMatchObject({ message: MEMBER_COPY });
    // No action means the status line paints no step at all.
    const step = renderStatusStep(MEMBER_COPY);
    expect(findPropsByType(step, 'Pressable')).toHaveLength(0);
  });

  it('keeps the retry control beside a retryable failure and offers no step', () => {
    const onRetry = vi.fn<() => void>();
    const retryable = renderFailure(
      { retryable: true, message: 'The connection dropped. Try again.' },
      onRetry
    );

    expect(findPropsByType(retryable, 'Button')).toHaveLength(1);
    expect(findPropsByComponent(retryable, RefusalStatus)).toMatchObject({
      message: 'The connection dropped. Try again.',
    });
  });

  it('paints the billing step as an underlined pressable that runs the action', () => {
    const status = renderStatusStep(BILLING_COPY, BILLING_STEP);
    const step = findPropsByType(status, 'Pressable')[0];
    expect(step).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Manage billing',
    });
    // Pressing the step runs exactly the action the failure carried.
    onPress.mockClear();
    const stepPress: unknown = step?.onPress;
    if (typeof stepPress !== 'function') {
      throw new TypeError('the billing step is not pressable');
    }
    const press: () => void = stepPress as () => void;
    press();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

/** The inline status line's own tree, so the step's rendering is asserted. */
function renderStatusStep(message: string, action?: TrialRefusalAction): Node {
  // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
  return RefusalStatus({ message, action }) as Node;
}
