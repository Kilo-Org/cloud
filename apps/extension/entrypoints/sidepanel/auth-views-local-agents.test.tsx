/* eslint-disable id-length, jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- the settings sections and the signed-in panel are replaced by fakes */
// @vitest-environment jsdom

import { fireEvent, render, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SignedInHeaderActions } from './auth-shell';
import { LoadingView, PendingView, SignedOutView, ValidationErrorView } from './auth-views';

vi.mock('#imports', () => ({ browser: {}, storage: {} }));

vi.mock('./local-agents-settings', () => ({
  LocalAgentsSettings: () => h('section', { 'aria-label': 'Local agents' }),
}));

vi.mock('@/src/shared/analytics', () => ({
  getFirefoxUsageDataGranted: () => Promise.resolve(true),
  loadAnalyticsOptOut: () => Promise.resolve(false),
  setAnalyticsOptOut: () => Promise.resolve(),
}));

vi.mock('./memory-settings', () => ({ MemorySettings: () => null }));
vi.mock('./workflow-settings', () => ({ WorkflowSettings: () => null }));
vi.mock('./web-mcp-settings', () => ({ WebMcpSettings: () => null }));
vi.mock('./remote-mcp-settings', () => ({ RemoteMcpSettings: () => null }));
vi.mock('./organization-credit-account', () => ({
  OrganizationCreditAccountSelect: () => null,
  useOrganizationCreditAccount: () => ({
    organizationOptions: [],
    selectOrganization: () => {},
    selectedOrganizationId: '',
  }),
}));
vi.mock('./agent-chat-panel', () => ({ AgentChatPanel: () => null }));
vi.mock('./agents-mode', () => ({ AgentsMode: () => null }));
vi.mock('./agents-mode-switch', () => ({ AgentsModeSwitch: () => null }));
vi.mock('./agents-provider', () => ({ ExtensionAgentsProvider: () => null }));
vi.mock('./pending-memory-save-card', () => ({ PendingMemorySaveCard: () => null }));
vi.mock('./pending-workflow-save-card', () => ({ PendingWorkflowSaveCard: () => null }));

const renderInFreshStore = (view: ReactElement) =>
  render(h(Provider, { store: createStore() }, view));

const openSettings = (view: ReactElement): HTMLElement => {
  const { getByRole } = renderInFreshStore(view);
  fireEvent.click(getByRole('button', { name: 'Settings' }));
  return getByRole('dialog', { name: 'Settings panel' });
};

const signedOutViews: readonly (readonly [string, ReactElement])[] = [
  [
    'signed out',
    h(SignedOutView, { error: null, isStarting: false, message: null, onSignIn: () => {} }),
  ],
  [
    'starting sign-in',
    h(SignedOutView, { error: null, isStarting: true, message: null, onSignIn: () => {} }),
  ],
  [
    'waiting for approval',
    h(PendingView, { onCancel: () => {}, onOpen: () => {}, userCode: 'ABCD-2345' }),
  ],
  ['session check failed', h(ValidationErrorView, { onRetry: () => {}, onSignInAgain: () => {} })],
];

describe('local agents settings without a Kilo account', () => {
  it.each(signedOutViews)('opens the local agents settings while %s', (_state, view) => {
    const dialog = openSettings(view);

    expect(within(dialog).getByRole('region', { name: 'Local agents' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(within(dialog).queryByText('Signed in')).toBeNull();
  });

  it('closes the signed-out settings with the close button', () => {
    const { getByRole, queryByRole } = renderInFreshStore(
      h(SignedOutView, { error: null, isStarting: false, message: null, onSignIn: () => {} })
    );

    fireEvent.click(getByRole('button', { name: 'Settings' }));
    fireEvent.click(getByRole('button', { name: 'Close settings' }));

    expect(queryByRole('dialog', { name: 'Settings panel' })).toBeNull();
  });

  it('shows no settings entry while the stored session is still being checked', () => {
    const { queryByRole } = renderInFreshStore(h(LoadingView));

    expect(queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('keeps the local agents settings next to Sign out when signed in', () => {
    const dialog = openSettings(
      h(SignedInHeaderActions, {
        auth: { token: 'token-1', userEmail: 'user@kilo.ai' },
        onOrganizationChange: () => {},
        onSignOut: () => {},
        organizationOptions: [],
        selectedOrganizationId: '',
      })
    );

    expect(within(dialog).getByRole('region', { name: 'Local agents' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
