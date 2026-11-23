// The organization settings mutations' refusal copy. A raw server sentence
// never reaches a toast: a known rejection becomes its localized explanation,
// everything else the generic line.
//
// The mock factories reference `toastError` before its `const` line, so it is
// hoisted; the factories themselves are hoisted by Vitest. Real TanStack Query
// drives the mutation observers; the only stubbed input is the procedure
// surface the hooks read at render time, following
// use-session-mutations.mounted.test.tsx.

import { createElement } from 'react';
import type * as ReactQuery from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type * as InfiniteRetentionModule from '@/lib/query/infinite-retention';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import {
  useSaveOrgGatewaySettings,
  useSaveOrgGuardrails,
  useSaveOrgModelAccess,
} from './use-org-settings-queries';

const toastError = vi.hoisted(() => vi.fn());
const reconcileFirstPageMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('sonner-native', () => ({ toast: { error: toastError, success: vi.fn() } }));
// Each save refreshes the organization audit log's page one after it lands.
// Only that export is replaced, so the rest of the module stays real and the
// call is recorded instead of touching the mounted client's cache.
vi.mock('@/lib/query/infinite-retention', async importOriginal => {
  const actual = await importOriginal<typeof InfiniteRetentionModule>();
  return { ...actual, reconcileFirstPage: reconcileFirstPageMock };
});
// The hooks take the reader's role as an argument; this harness passes the
// money role, because these are organizationAdmin writes, so every refusal
// reaches a reader who can change the plan, and this suite's subject is the
// toast copy that reader gets — the sentence that names the destination,
// because no billing step is rendered here.

type MutationOptions = ReactQuery.MutationOptions<unknown, Error, unknown>;

const rpc = vi.hoisted(() => ({
  guardrailsUpdate: vi.fn<(input: unknown) => Promise<unknown>>(),
  updateAllowLists: vi.fn<(input: unknown) => Promise<unknown>>(),
  updateGatewaySettings: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      guardrails: {
        update: {
          mutationOptions: (options: MutationOptions) => ({
            ...options,
            mutationFn: rpc.guardrailsUpdate,
          }),
        },
        // The save writes the answer it received into this read's cache.
        get: { queryKey: (input: unknown) => [['organizations', 'guardrails', 'get'], input] },
      },
      settings: {
        updateAllowLists: {
          mutationOptions: (options: MutationOptions) => ({
            ...options,
            mutationFn: rpc.updateAllowLists,
          }),
        },
        updateGatewaySettings: {
          mutationOptions: (options: MutationOptions) => ({
            ...options,
            mutationFn: rpc.updateGatewaySettings,
          }),
        },
        listAvailableModels: {
          queryKey: (input: unknown) => [['organizations', 'settings', 'listAvailableModels'], input],
        },
        getGatewaySettings: {
          queryKey: (input: unknown) => [['organizations', 'settings', 'getGatewaySettings'], input],
        },
      },
      withMembers: { queryKey: () => [['organizations', 'withMembers']] },
      list: { queryKey: () => [['organizations', 'list']] },
    },
    models: { list: { queryKey: () => [['models', 'list']] } },
  }),
}));

type SaveMutation<I> = {
  mutateAsync: (input: I) => Promise<unknown>;
};

type ProbeProps<I> = Readonly<{
  useMutation: (organizationId: string | null) => SaveMutation<I>;
  input: I;
}>;

/**
 * Exposes the hook's `mutateAsync` on a Pressable host. A press runs the
 * mutation; the observer's `onError` fires when it settles, so the toast mock
 * is what the test asserts on. The call lives in the event, not in render: a
 * render-time call would re-run on every observer state change. The input type
 * comes from each real hook's own variables, so no cast narrows the payload.
 */
function Probe<I>({ useMutation, input }: ProbeProps<I>) {
  const mutation = useMutation('org-1');
  return createElement('Pressable', {
    onPress: () => {
      const fire = async () => {
        try {
          await mutation.mutateAsync(input);
        } catch {
          // The observer's onError already reported; nothing to add here.
        }
      };
      void fire();
    },
  });
}

function rejection(message: string, code: string): Error {
  return Object.assign(new Error(message), { data: { code, message } });
}

async function mountWith<I>(useMutation: ProbeProps<I>['useMutation'], input: I) {
  toastError.mockClear();
  const mounted = await renderWithProviders(
    createElement<ProbeProps<I>>(Probe, { useMutation, input }),
    {
      queryClient: createTestQueryClient(),
    }
  );
  return mounted;
}

async function pressFire(renderer: ReactTestRenderer) {
  const [fire] = renderer.root.findAll(node => String(node.type) === 'Pressable');
  if (fire === undefined) {
    throw new Error('the mutation probe rendered no fire control');
  }
  await act(async () => {
    (fire.props.onPress as () => void)();
    await Promise.resolve();
  });
}

describe("organization settings refusal toasts — the localization hook's contract", () => {
  it('guardrails save explains a lapsed organization plan instead of echoing the words', async () => {
    rpc.guardrailsUpdate.mockRejectedValue(
      rejection('Organization trial has expired.', 'FORBIDDEN')
    );
    const { renderer, unmount } = await mountWith(() => useSaveOrgGuardrails('org-1', true), {
      organizationId: 'org-1',
      enabled: false,
      detectors: {
        injection_attack: { enabled: false, action: 'block' },
        pii: { enabled: false, action: 'block', entities: [] },
        keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
        topic_detector: { enabled: false, topic: [] },
        policy_violation: {
          enabled: false,
          action: 'block',
          format: 'policy_text',
          policy_text: '',
          rules: [],
        },
        toxicity: { enabled: false },
        nsfw: { enabled: false },
        bias: { enabled: false, action: 'block' },
        sponge_attack: { enabled: false },
      },
    });
    await pressFire(renderer);

    expect(toastError).toHaveBeenCalledWith(i18n.t('common.organizationTrialEndedBillingAtKiloAi'));
    unmount();
  });

  it('model access toasts the generic line for an unrecognized refusal', async () => {
    rpc.updateAllowLists.mockRejectedValue(rejection('Failed to update guardrails', 'PATCH'));
    const { renderer, unmount } = await mountWith(() => useSaveOrgModelAccess('org-1', true), {
      organizationId: 'org-1',
    });
    await pressFire(renderer);

    expect(toastError).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
    unmount();
  });

  it('gateway settings toasts the generic line for an unrecognized refusal', async () => {
    rpc.updateGatewaySettings.mockRejectedValue(
      rejection('Failed to update gateway settings', 'PATCH')
    );
    const { renderer, unmount } = await mountWith(() => useSaveOrgGatewaySettings('org-1', true), {
      organizationId: 'org-1',
    });
    await pressFire(renderer);

    expect(toastError).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
    unmount();
  });
});

// Every save that lands writes an organization audit row, so its success path
// refreshes the audit log's page one. The client is the real mounted one.
describe('organization settings saves refresh the audit log', () => {
  async function pressSave<I>(
    useMutation: ProbeProps<I>['useMutation'],
    input: I
  ): Promise<{ queryClient: ReactQuery.QueryClient; unmount: () => void }> {
    reconcileFirstPageMock.mockClear();
    const { renderer, queryClient, unmount } = await mountWith(useMutation, input);
    await pressFire(renderer);
    await waitFor(() => reconcileFirstPageMock.mock.calls.length > 0);
    return { queryClient, unmount };
  }

  it('guardrails save reconciles the audit log page one', async () => {
    rpc.guardrailsUpdate.mockResolvedValue(undefined);
    const { queryClient, unmount } = await pressSave(
      () => useSaveOrgGuardrails('org-1', true),
      {
        organizationId: 'org-1',
        enabled: false,
        detectors: {
          injection_attack: { enabled: false, action: 'block' },
          pii: { enabled: false, action: 'block', entities: [] },
          keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
          topic_detector: { enabled: false, topic: [] },
          policy_violation: {
            enabled: false,
            action: 'block',
            format: 'policy_text',
            policy_text: '',
            rules: [],
          },
          toxicity: { enabled: false },
          nsfw: { enabled: false },
          bias: { enabled: false, action: 'block' },
          sponge_attack: { enabled: false },
        },
      }
    );

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClient, [
      'organizations.auditLogs.list',
      'org-1',
    ]);
    unmount();
  });

  it('model access save reconciles the audit log page one', async () => {
    rpc.updateAllowLists.mockResolvedValue({ success: true });
    const { queryClient, unmount } = await pressSave(
      () => useSaveOrgModelAccess('org-1', true),
      { organizationId: 'org-1' }
    );

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClient, [
      'organizations.auditLogs.list',
      'org-1',
    ]);
    unmount();
  });

  it('gateway settings save reconciles the audit log page one', async () => {
    rpc.updateGatewaySettings.mockResolvedValue({ success: true });
    const { queryClient, unmount } = await pressSave(
      () => useSaveOrgGatewaySettings('org-1', true),
      { organizationId: 'org-1' }
    );

    expect(reconcileFirstPageMock).toHaveBeenCalledExactlyOnceWith(queryClient, [
      'organizations.auditLogs.list',
      'org-1',
    ]);
    unmount();
  });

  it('a save with no organization reconciles nothing', async () => {
    rpc.updateGatewaySettings.mockResolvedValue({ success: true });
    reconcileFirstPageMock.mockClear();
    const { renderer, queryClient, unmount } = await renderWithProviders(
      createElement<ProbeProps<{ organizationId: string }>>(Probe, {
        useMutation: () => useSaveOrgGatewaySettings(null, true),
        input: { organizationId: 'org-1' },
      }),
      { queryClient: createTestQueryClient() }
    );
    await pressFire(renderer);
    // Wait for the mutation to report success, so the assertion covers a save
    // whose `onSuccess` really ran instead of one that never settled.
    await waitFor(() =>
      queryClient.getMutationCache().getAll().some(mutation => mutation.state.status === 'success')
    );

    expect(rpc.updateGatewaySettings).toHaveBeenCalled();
    expect(reconcileFirstPageMock).not.toHaveBeenCalled();
    unmount();
  });
});
