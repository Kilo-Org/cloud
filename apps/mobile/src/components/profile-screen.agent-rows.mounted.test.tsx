import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  authState,
  findConfigureRows,
  flushIdle,
  getProfileAgentScopeMock,
  idleState,
  keys,
  mountProfile,
  organizationsQueryFn,
  providersQueryFn,
  routerPush,
  signOutFn,
} from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { getCodeReviewerProfilePath, getProfilesPath } from '@/lib/profile-agent-navigation';
import type * as ProfileAgentNavigationModule from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { act } from '@/test/renderer';
import { createTestQueryClient, waitFor } from '@/test/render-with-providers';

/**
 * The three rows under AGENTS in the Profile tab are the only way into the code
 * reviewer, the security agent and the agent profiles from that tab, and each
 * one opens the screen for the account scope the tab shows.
 */
describe('ProfileScreen agent rows', () => {
  beforeEach(() => {
    providersQueryFn.mockReset();
    organizationsQueryFn.mockReset();
    signOutFn.mockReset();
    routerPush.mockReset();
    authState.token = 'token-1';
    idleState.storedCallback = undefined;
    idleState.cancel.mockReset();
    getProfileAgentScopeMock.mockReset();
  });

  function cachedProfile() {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.providers, {
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    queryClient.setQueryData(keys.organizations, [
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
    ]);
    return queryClient;
  }

  function pressRow(root: Parameters<typeof findConfigureRows>[0], title: string) {
    const [row] = findConfigureRows(root, title);
    const onPress = row?.props.onPress as (() => void) | undefined;
    if (!onPress) {
      throw new Error(`The ${title} row is not pressable`);
    }
    act(() => {
      onPress();
    });
  }

  it('opens each screen for the selected organization', async () => {
    getProfileAgentScopeMock.mockReturnValue('org-1');

    const { renderer, unmount } = await mountProfile(cachedProfile());
    const root = renderer.root;

    pressRow(root, i18n.t('common.codeReviewer'));
    expect(routerPush).toHaveBeenLastCalledWith(getCodeReviewerProfilePath('org-1'));

    pressRow(root, i18n.t('common.securityAgent'));
    expect(routerPush).toHaveBeenLastCalledWith(getSecurityAgentPath('org-1'));

    pressRow(root, i18n.t('profiles.title'));
    expect(routerPush).toHaveBeenLastCalledWith(getProfilesPath());

    expect(routerPush).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('opens each screen for the personal scope', async () => {
    getProfileAgentScopeMock.mockReturnValue('personal');

    const { renderer, unmount } = await mountProfile(cachedProfile());
    const root = renderer.root;

    pressRow(root, i18n.t('common.codeReviewer'));
    expect(routerPush).toHaveBeenLastCalledWith(getCodeReviewerProfilePath('personal'));

    pressRow(root, i18n.t('common.securityAgent'));
    expect(routerPush).toHaveBeenLastCalledWith(getSecurityAgentPath('personal'));

    unmount();
  });

  it('keeps both rows usable from cached organizations while a refresh is in flight', async () => {
    // The real resolver, not a canned scope: gating the scope on the refresh
    // disabled both rows for as long as the organizations read kept fetching,
    // with no error and no way in.
    const navigation = await vi.importActual<typeof ProfileAgentNavigationModule>(
      '@/lib/profile-agent-navigation'
    );
    getProfileAgentScopeMock.mockImplementation(navigation.getProfileAgentScope);
    providersQueryFn.mockResolvedValue({ providers: [] });
    // A refresh that never answers.
    const stalledRefresh = Promise.withResolvers<undefined>();
    organizationsQueryFn.mockReturnValue(stalledRefresh.promise);

    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.organizations, [
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
    ]);

    const { renderer, unmount } = await mountProfile(queryClient);
    const root = renderer.root;

    flushIdle();
    act(() => {
      // The refetch never answers, so this promise stays pending by design.
      void queryClient.invalidateQueries({ queryKey: keys.organizations });
    });
    await waitFor(() => queryClient.getQueryState(keys.organizations)?.fetchStatus === 'fetching');
    // Flush the observer notification the refetch schedules, so the rows are
    // judged on a render that knows the refresh is in flight.
    await act(async () => {
      const tick = Promise.withResolvers<undefined>();
      setTimeout(() => {
        tick.resolve(undefined);
      }, 0);
      await tick.promise;
    });

    const [codeReviewerRow] = findConfigureRows(root, i18n.t('common.codeReviewer'));
    const [securityAgentRow] = findConfigureRows(root, i18n.t('common.securityAgent'));
    expect(codeReviewerRow?.props.disabled).toBe(false);
    expect(securityAgentRow?.props.disabled).toBe(false);

    pressRow(root, i18n.t('common.codeReviewer'));
    expect(routerPush).toHaveBeenLastCalledWith(getCodeReviewerProfilePath('org-1'));

    pressRow(root, i18n.t('common.securityAgent'));
    expect(routerPush).toHaveBeenLastCalledWith(getSecurityAgentPath('org-1'));

    unmount();
  });
});
