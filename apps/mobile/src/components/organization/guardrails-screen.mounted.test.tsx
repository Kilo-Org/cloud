/* eslint-disable max-lines -- one mounted suite for the unavailable state's contract: the heading that does not repeat the header, the reason it names, and the support action. */

// The guardrails' "not enabled" state contract, driven through the screen's
// own JSX with the data layer mocked: the EmptyState heading differs from the
// ScreenHeader title, the description names the reason (Kilo enables the
// feature per organization) and the next step, and the state's way out is the
// support mail draft. The states above it in the render order (boundary,
// permission denial, missing membership payload) are each one read away, so
// each gets its own case here.

import { i18n } from '@/i18n';
import { createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationGuardrailsScreen } from '@/components/organization/guardrails-screen';
import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// The suite renders `useTranslation` through the shared instance; a module-level
// `t()` binds it before the first render, the way the other screen suites do.
const EXPECTED_TITLE = i18n.t('organizationGuardrails.unavailableTitle');
const EXPECTED_REASON = i18n.t('organizationGuardrails.unavailable');
const EXPECTED_ACTION = i18n.t('organizationGuardrails.contactSupport');

const boundary = vi.hoisted(() => {
  const state: {
    organizationId: string | null;
    role: string;
    org: { organizationId: string } | null;
    isResolving: boolean;
  } = {
    organizationId: 'org-1',
    role: 'owner',
    org: { organizationId: 'org-1' },
    isResolving: false,
  };
  return state;
});

const membership = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  isFetching: false,
  isError: false,
  isPaused: false,
  refetch: vi.fn<() => void>(),
}));

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const openExternal = vi.hoisted(() => vi.fn());

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundary,
  useOrgWithMembers: () => membership,
}));
vi.mock('@/lib/hooks/use-org-settings-queries', () => ({
  useOrgGuardrails: () => ({ isPending: false, isError: false, data: null }),
  useSaveOrgGuardrails: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useColorScheme: () => 'light',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: openExternal }));
vi.mock('@/lib/hooks/use-surface-feedback', () => ({ useSurfaceFeedback: () => vi.fn() }));
// EmptyState's centered-surface chain reads the native surface-geometry module
// through the expo package, which cannot load in this project; the state only
// reads the answer, so a module that answers unavailable is what it needs.
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
// The skeleton and the accessible status reach `lib/a11y/motion`, whose
// expo-battery import cannot load here; the state only reads the policy.
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reduceMotion: false }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-worklets', () => ({}));
vi.mock('react-native-gesture-handler', () => ({}));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: 'PermissionDenied',
}));
vi.mock('@/components/organization/guardrails-input-section', () => ({
  InputGuardrailsSection: 'InputGuardrailsSection',
}));
vi.mock('@/components/organization/guardrails-output-section', () => ({
  OutputGuardrailsSection: 'OutputGuardrailsSection',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string }) => createElement('ScreenHeaderMock', null, props.title),
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { onPress?: () => void; children?: ReactNode }) =>
    createElement('ButtonMock', { onPress: props.onPress }, props.children),
}));
vi.mock('@/components/ui/icons', () => ({ Lock: 'Lock' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title?: string; description?: ReactNode; action?: ReactNode }) =>
    createElement('EmptyStateMock', null, props.title, props.description, props.action),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

beforeEach(() => {
  boundary.organizationId = 'org-1';
  boundary.role = 'owner';
  boundary.org = { organizationId: 'org-1' };
  boundary.isResolving = false;
  membership.data = null;
  membership.isError = false;
  openExternal.mockReset();
});

describe('OrganizationGuardrailsScreen not-enabled state', () => {
  it('gives the EmptyState its own heading instead of repeating the header title', async () => {
    membership.data = { settings: { kilo_encrypt: false } };

    const { renderer } = await renderWithProviders(createElement(OrganizationGuardrailsScreen));
    await waitFor(() => collectText(renderer.toJSON()).includes(EXPECTED_TITLE));

    const headers = renderer.root.findAll(node => String(node.type) === 'ScreenHeaderMock').length;
    const texts = collectText(renderer.toJSON());

    expect(headers).toBe(1);
    expect(texts).toContain('AI Guardrails');
    expect(texts).toContain(EXPECTED_TITLE);

    act(() => {
      renderer.unmount();
    });
  });

  it('names the reason and the next step, with the real support address interpolated', async () => {
    membership.data = { settings: { kilo_encrypt: false } };

    const { renderer } = await renderWithProviders(createElement(OrganizationGuardrailsScreen));
    await waitFor(() => collectText(renderer.toJSON()).includes(EXPECTED_REASON));
    const texts = collectText(renderer.toJSON());

    expect(texts.join(' ')).toContain(EXPECTED_REASON);
    expect(texts.join(' ')).toContain(`Contact ${SUPPORT_EMAIL}, and the Kilo team`);
    expect(texts.join(' ')).not.toContain('{{supportEmail}}');

    act(() => {
      renderer.unmount();
    });
  });

  it('offers the support mail draft as the way out of the state', async () => {
    membership.data = { settings: { kilo_encrypt: false } };

    const { renderer } = await renderWithProviders(createElement(OrganizationGuardrailsScreen));
    await waitFor(() => collectText(renderer.toJSON()).includes(EXPECTED_REASON));
    const button = renderer.root.find(
      node => String(node.type) === 'ButtonMock' && collectText(node).includes(EXPECTED_ACTION)
    );

    act(() => {
      (button.props.onPress as (() => void) | undefined)?.();
    });

    expect(openExternal).toHaveBeenCalledWith(`mailto:${SUPPORT_EMAIL}`, {
      label: EXPECTED_ACTION,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the old boundary state for an account with no organization', async () => {
    boundary.organizationId = null;
    boundary.org = null;
    boundary.isResolving = false;

    const { renderer } = await renderWithProviders(createElement(OrganizationGuardrailsScreen));

    expect(
      renderer.root.findAll(node => String(node.type) === 'OrganizationBoundary')
    ).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
