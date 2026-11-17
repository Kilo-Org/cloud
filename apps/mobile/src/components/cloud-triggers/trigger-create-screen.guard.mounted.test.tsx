/**
 * The New trigger screen's leave guard.
 *
 * A draft the reader typed must not vanish behind one Back press: the header
 * back arrow, Android Back and the back gesture all remove this route, so the
 * shared keep-editing gate (`useMetadataLeaveGuard`) covers all three through
 * its `isDirty` computation. A clean form leaves without asking, and a create
 * that succeeded leaves without asking about the draft it just saved.
 */

import { createElement } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { resetLeaveSettle } from '@/lib/navigation/leave-settle';

import { TriggerCreateScreen } from './trigger-create-screen';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  confirm: vi.fn(),
  repeat: vi.fn(),
  repeatSawEnabled: [] as boolean[],
  guard: {
    enabled: false as boolean,
    handler: undefined as
      | ((options: { data: { action: { type: string } }; repeat: () => void }) => void)
      | undefined,
  },
  createMutation: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('expo-router', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
  ) => {
    h.guard.enabled = enabled;
    h.guard.handler = handler;
  },
  usePathname: () => '/(app)/(tabs)/(3_profile)/triggers/new',
  useNavigation: () => ({
    getState: () => ({ index: 1, routes: [{ key: 'tab', name: '(tabs)' }, { key: 'new', name: 'triggers/new' }] }),
    addListener: () => vi.fn(),
    isFocused: () => true,
  }),
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
  useLocalSearchParams: () => ({}),
}));

vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: h.replace }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    webhookTriggers: {
      create: { mutationOptions: () => ({}) },
      list: { pathFilter: () => ({ queryKey: ['webhookTriggers', 'list'] }) },
    },
  }),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<object>()),
  useMutation: () => h.createMutation,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  View: 'View',
  ScrollView: 'ScrollView',
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('./trigger-form', () => ({
  TriggerForm: (props: Record<string, unknown>) => createElement('TriggerForm', props),
}));

function discardRequest() {
  const request = h.confirm.mock.calls.at(-1)?.[0] as
    | { onConfirm?: () => void; onCancel?: () => void }
    | undefined;
  if (!request) {
    throw new Error('the discard confirmation was not raised');
  }
  return request;
}

/** Hand the guard the removal the navigator produces for a Back press. */
function pressBack() {
  const handler = h.guard.handler;
  if (!handler) {
    throw new Error('the guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        h.repeatSawEnabled.push(h.guard.enabled);
        h.repeat();
      },
    });
  });
}

describe('TriggerCreateScreen leave guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetLeaveSettle();
    h.guard.enabled = false;
    h.guard.handler = undefined;
    h.repeatSawEnabled = [];
  });

  it('leaves a clean form without asking', async () => {
    await renderWithProviders(<TriggerCreateScreen />);

    expect(h.guard.enabled).toBe(false);
    pressBack();

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.repeatSawEnabled).toEqual([false]);
  });

  it('asks before leaving a draft, and Keep editing keeps the guard on', async () => {
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    // The form is mocked; drive the draft change the form would report.
    const formNode = renderer.root.findByProps({ mode: 'create' });
    const formProps = formNode.props as {
      onDraftChange: (next: Record<string, unknown>) => void;
    };
    act(() => {
      formProps.onDraftChange({
        name: 'probe-draft',
        activation: 'webhook',
        cron: '',
        timezone: 'UTC',
        repository: '',
        agent: 'code',
        model: '',
        variant: '',
        prompt: 'Describe this webhook request payload:\n\n{{body}}',
        environmentId: null,
        profileId: null,
        bodySchemaJson: '',
        autoCommit: false,
        condenseOnComplete: false,
        active: true,
        authEnabled: false,
        authHeader: '',
        authSecret: '',
        runAsCreator: false,
      });
    });
    expect(h.guard.enabled).toBe(true);

    pressBack();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });

    act(() => {
      discardRequest().onCancel?.();
    });

    expect(h.repeat).not.toHaveBeenCalled();
    expect(h.guard.enabled).toBe(true);
  });

  it('Discard replays the leave and disarms the guard', async () => {
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    const formProps = renderer.root.findByProps({ mode: 'create' }).props as {
      onDraftChange: (next: Record<string, unknown>) => void;
    };
    act(() => {
      formProps.onDraftChange({
        name: 'probe-draft',
        activation: 'webhook',
        cron: '',
        timezone: 'UTC',
        repository: '',
        agent: 'code',
        model: '',
        variant: '',
        prompt: 'Describe this webhook request payload:\n\n{{body}}',
        environmentId: null,
        profileId: null,
        bodySchemaJson: '',
        autoCommit: false,
        condenseOnComplete: false,
        active: true,
        authEnabled: false,
        authHeader: '',
        authSecret: '',
        runAsCreator: false,
      });
    });
    pressBack();
    expect(h.repeat).not.toHaveBeenCalled();

    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });

    expect(h.repeat).toHaveBeenCalledTimes(1);
    expect(h.repeatSawEnabled).toEqual([false]);
    expect(h.guard.enabled).toBe(false);
  });

  it('a create that succeeded leaves without asking about the saved draft', async () => {
    h.createMutation.mutateAsync.mockResolvedValue({ triggerId: 'trigger-new' });
    const { renderer } = await renderWithProviders(<TriggerCreateScreen />);

    const formProps = renderer.root.findByProps({ mode: 'create' }).props as {
      onDraftChange: (next: Record<string, unknown>) => void;
      onSubmit: () => void;
    };
    act(() => {
      formProps.onDraftChange({
        name: 'trigger-new',
        activation: 'webhook',
        cron: '',
        timezone: 'UTC',
        repository: 'owner/repo',
        agent: 'code',
        model: 'kilo-auto/efficient',
        variant: '',
        prompt: 'Describe this webhook request payload:\n\n{{body}}',
        environmentId: null,
        profileId: null,
        bodySchemaJson: '',
        autoCommit: false,
        condenseOnComplete: false,
        active: true,
        authEnabled: false,
        authHeader: '',
        authSecret: '',
        runAsCreator: false,
      });
    });
    expect(h.guard.enabled).toBe(true);

    await act(async () => {
      formProps.onSubmit();
      await Promise.resolve();
    });

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/triggers/trigger-new');
    // The leave waits one task behind the disarm render (`useMetadataLeaveGuard`).
    await waitFor(() => !h.guard.enabled);
    expect(h.guard.enabled).toBe(false);
  });
});
