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
import { act, type ReactTestRenderer } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';
import {
  useSaveOrgGatewaySettings,
  useSaveOrgGuardrails,
  useSaveOrgModelAccess,
} from './use-org-settings-queries';

const toastError = vi.hoisted(() => vi.fn());

vi.mock('sonner-native', () => ({ toast: { error: toastError, success: vi.fn() } }));

type MutationOptions = ReactQuery.MutationOptions<unknown, Error, unknown>;

const rpc = vi.hoisted(() => ({
  guardrailsUpdate: vi.fn<(input: unknown) => Promise<never>>(),
  updateAllowLists: vi.fn<(input: unknown) => Promise<never>>(),
  updateGatewaySettings: vi.fn<(input: unknown) => Promise<never>>(),
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

async function mountWith<I>(
  useMutation: ProbeProps<I>['useMutation'],
  input: I
) {
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
    const { renderer, unmount } = await mountWith(useSaveOrgGuardrails, {
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

    expect(toastError).toHaveBeenCalledWith(i18n.t('common.organizationTrialEnded'));
    unmount();
  });

  it('model access toasts the generic line for an unrecognized refusal', async () => {
    rpc.updateAllowLists.mockRejectedValue(rejection('Failed to update guardrails', 'PATCH'));
    const { renderer, unmount } = await mountWith(useSaveOrgModelAccess, {
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
    const { renderer, unmount } = await mountWith(useSaveOrgGatewaySettings, {
      organizationId: 'org-1',
    });
    await pressFire(renderer);

    expect(toastError).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
    unmount();
  });
});
