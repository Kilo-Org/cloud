/**
 * The delete confirmation's body states what stops, and that depends on the
 * trigger: a scheduled trigger stops firing, while a webhook trigger's calls
 * start failing. The panel picks the copy from the trigger's activation mode,
 * so one fixture per mode pins each branch of that choice.
 */

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type CloudTriggerDetail } from '@/lib/cloud-triggers/trigger-draft';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerEditPanel } from './trigger-edit-panel';

type ConfirmRequest = { title: string; message: string; onConfirm: () => void };

const state = vi.hoisted(() => ({
  requests: [] as { title: string; message: string; onConfirm: () => void }[],
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
// The panel's post-delete hand-off goes through the stack-safe replace; the
// hook's own navigation plumbing is irrelevant here, and its mechanics are
// covered by the navigation folder's suite.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: vi.fn() }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: ConfirmRequest) => {
      state.requests.push(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/components/ui/icons', () => ({ Play: 'Play', Trash2: 'Trash2' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#dc2626', foreground: '#111111' }),
}));
vi.mock('@/lib/cloud-triggers/use-cloud-triggers', () => ({
  useTriggerMutations: () => ({
    remove: { mutate: vi.fn(), isPending: false },
    invoke: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    webhookTriggers: {
      update: { mutationOptions: () => ({ mutationFn: () => Promise.resolve(undefined) }) },
      list: { pathFilter: () => ({ queryKey: ['webhookTriggers', 'list'] }) },
      get: { queryKey: () => ['webhookTriggers', 'get'] },
    },
  }),
}));
// The form is the panel's heaviest child and its only job here is to hold the
// footer that carries the Delete control. Vitest hoists a mock factory above
// the static imports, so React is imported inside it: a top-level `createElement`
// would still be in its temporal dead zone when the factory runs.
vi.mock('./trigger-form', async () => {
  const React = await import('react');
  return {
    TriggerForm: (props: { footer?: ReactNode }) => React.createElement('View', null, props.footer),
  };
});
vi.mock('./trigger-deliveries', () => ({ TriggerDeliveries: () => null }));
vi.mock('./trigger-url-card', () => ({ TriggerUrlCard: () => null }));

const BUTTON = 'Button' as const;
const TEXT = 'Text' as const;

let renderer: ReactTestRenderer | undefined = undefined;

/** A trigger's detail as the worker answers it, for one activation mode. */
function detailFor(
  activationMode: CloudTriggerDetail['activationMode'],
  triggerId: string
): CloudTriggerDetail {
  const scheduled = activationMode === 'scheduled';
  return {
    triggerId,
    namespace: 'user/user-1',
    userId: 'user-1',
    orgId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: true,
    targetType: 'cloud_agent',
    githubRepo: 'kilo-org/cloud',
    mode: 'code',
    model: null,
    variant: null,
    environmentId: null,
    profileId: null,
    promptTemplate: 'Ask me anything',
    bodySchema: null,
    autoCommit: false,
    condenseOnComplete: false,
    webhookAuthConfigured: !scheduled,
    activationMode,
    cronExpression: scheduled ? '0 9 * * *' : null,
    cronTimezone: scheduled ? 'UTC' : null,
    inboundUrl: `https://Inbound.example/${triggerId}`,
    canEdit: true,
    canEditReason: null,
    canRun: true,
  };
}

async function mount(detail: CloudTriggerDetail): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(TriggerEditPanel, { detail }));
  renderer = view.renderer;
  return view.renderer.root;
}

/** The Delete control is the button whose label is the shared delete copy. */
function deleteButton(root: ReactTestRenderer['root']): ReactTestInstance {
  const [label] = root.findAll(
    node => Object.is(node.type, TEXT) && node.props.children === i18n.t('common.delete')
  );
  if (label === undefined) {
    throw new Error('the panel rendered no Delete label');
  }
  const parent = label.parent;
  if (parent === null || !Object.is(parent.type, BUTTON)) {
    throw new Error('the Delete label is not inside a Button');
  }
  return parent;
}

function press(node: ReactTestInstance): void {
  const onPress: unknown = node.props.onPress;
  if (typeof onPress !== 'function') {
    throw new TypeError('expected an onPress handler');
  }
  act(() => {
    (onPress as () => void)();
  });
}

beforeEach(() => {
  state.requests.length = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TriggerEditPanel delete confirmation', () => {
  it('says a scheduled trigger stops firing', async () => {
    const root = await mount(detailFor('scheduled', 'nightly-report'));

    press(deleteButton(root));

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.message).toBe(
      i18n.t('cloudAgent.triggers.deleteMessageScheduled', { name: 'nightly-report' })
    );
  });

  it('says a webhook trigger stops answering calls', async () => {
    const root = await mount(detailFor('webhook', 'nightly-report'));

    press(deleteButton(root));

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.message).toBe(
      i18n.t('cloudAgent.triggers.deleteMessage', { name: 'nightly-report' })
    );
  });
});
