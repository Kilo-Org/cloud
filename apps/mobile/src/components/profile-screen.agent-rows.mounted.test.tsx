import { beforeEach, describe, expect, it } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  authState,
  findConfigureRows,
  getProfileAgentScopeMock,
  interactionState,
  keys,
  mountProfile,
  organizationsQueryFn,
  providersQueryFn,
  routerPush,
  signOutFn,
} from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { getCodeReviewerProfilePath, getProfilesPath } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { act } from '@/test/renderer';
import { createTestQueryClient } from '@/test/render-with-providers';

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
    interactionState.storedCallback = undefined;
    interactionState.cancel.mockReset();
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
});
