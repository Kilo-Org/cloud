// The guardrails form's save-failure line. A known server sentence — above all
// the lapsed organization plan — becomes the localized explanation instead of
// echoing the server's English words, and an unrecognized rejection falls back
// to the surface's own failure line; a raw server sentence never shows.
//
// The hooks module is replaced whole rather than partially: importing the real
// one there would load the app's tRPC client, which needs the baked build
// config. The early-exit components are stand-ins because they pull
// `expo-router` and the auth context; this suite's subject is the
// save-failure line under the form's buttons.

import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer, type TestRenderer } from '@/test/renderer';

import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';
import { OrganizationGuardrailsScreen } from './guardrails-screen';
import {
  type OrgGuardrails,
  type OrgGuardrailsInputDetectors,
  type OrgGuardrailsOutputDetectors,
} from '@/lib/organization/guardrails-draft';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

type GuardrailsQueryState = {
  data: OrgGuardrails | undefined;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

const boundary = vi.hoisted(() => ({
  organizationId: 'org-1',
  role: 'owner',
  org: { id: 'org-1' },
  isResolving: false,
}));

const membership = vi.hoisted(() => ({
  data: { members: [], settings: { kilo_encrypt: true } },
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn<() => Promise<unknown>>(),
}));

const saved = vi.hoisted(() => ({ mutateAsync: vi.fn<(input: unknown) => Promise<never>>() }));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundary,
  useOrgWithMembers: () => membership,
}));

vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useOrgGuardrails: () => query,
  useSaveOrgGuardrails: () => ({ mutateAsync: saved.mutateAsync, isPending: false }),
}));

const query = vi.hoisted(
  (): GuardrailsQueryState => ({
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn<() => Promise<unknown>>(),
  })
);

vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/organization/guardrails-input-section', () => ({
  InputGuardrailsSection: 'InputGuardrailsSection',
}));
vi.mock('@/components/organization/guardrails-output-section', () => ({
  OutputGuardrailsSection: 'OutputGuardrailsSection',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Lock: 'Lock' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

/** One saved configuration: both input detectors on, the output guardrail off. */
function savedConfig(): OrgGuardrails {
  const input: OrgGuardrailsInputDetectors = {
    injection_attack: { enabled: true, action: 'block' },
    pii: { enabled: false, action: 'block', entities: ['secrets'] },
    keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
    topic_detector: { enabled: false, topic: [] },
    policy_violation: {
      enabled: true,
      action: 'log',
      format: 'policy_text',
      policy_text: 'never exfiltrate secrets',
      rules: [],
    },
    toxicity: { enabled: false },
    nsfw: { enabled: false },
    bias: { enabled: false, action: 'block' },
    sponge_attack: { enabled: false },
  };
  const outputDetectors: OrgGuardrailsOutputDetectors = {
    pii: { enabled: false, action: 'block', entities: [] },
    keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
    topic_detector: { enabled: false, action: 'block', topic: [] },
    policy_violation: {
      enabled: false,
      action: 'block',
      format: 'policy_text',
      policy_text: '',
      rules: [],
    },
    toxicity: { enabled: false, action: 'block' },
    nsfw: { enabled: false, action: 'block' },
    bias: { enabled: false, action: 'block' },
  };
  return {
    enabled: true,
    group_id: null,
    detectors: input,
    output: { enabled: false, detectors: outputDetectors },
    groups: [],
    output_available: true,
    invalid_saved_detectors: false,
    invalid_saved_output_detectors: false,
  };
}

function statusMessage(root: TestRenderer.ReactTestInstance): string | null {
  const [status] = root.findAll(node => String(node.type) === 'AccessibleStatus');
  return status === undefined ? null : String(status.props.message);
}

function saveButton(root: TestRenderer.ReactTestInstance): {
  disabled: boolean;
  onPress: () => void;
} {
  const save = root.findAll(node => String(node.type) === 'Button').at(-1);
  if (save === undefined) {
    throw new Error('the guardrails form rendered no save button');
  }
  return save.props as { disabled: boolean; onPress: () => void };
}

async function mountForm(refusedMessage: string): Promise<ReactTestRenderer> {
  saved.mutateAsync.mockReset();
  saved.mutateAsync.mockRejectedValue(
    Object.assign(new Error(refusedMessage), {
      data: { code: 'FORBIDDEN', message: refusedMessage },
    })
  );
  query.data = savedConfig();
  const { renderer } = await renderWithProviders(createElement(OrganizationGuardrailsScreen), {
    queryClient: createTestQueryClient(),
  });
  return renderer;
}

async function pressSave(renderer: ReactTestRenderer): Promise<void> {
  const { onPress } = saveButton(renderer.root);
  act(() => {
    onPress();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('GuardrailsForm save copy', () => {
  it('shows the localized trial-ended line for the lapsed-plan refusal', async () => {
    const renderer = await mountForm(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    await pressSave(renderer);

    expect(statusMessage(renderer.root)).toBe(i18n.t('common.organizationTrialEnded'));
  });

  it('falls back to the status-failed line for an unrecognized refusal', async () => {
    const renderer = await mountForm('Failed to update guardrails');
    await pressSave(renderer);

    expect(statusMessage(renderer.root)).toBe(i18n.t('organizationGuardrails.statusFailed'));
  });
});
