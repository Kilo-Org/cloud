import { useCallback, useEffect, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, AppState, Platform } from 'react-native';

import { i18n } from '@/i18n';
import { AgentSessionListScreen } from '@/components/agents/session-list-screen';
import { AgentsViewSegment } from '@/components/todos/agents-view-segment';
import { TodoListsScreen } from '@/components/todos/todo-lists-screen';
import { runPendingWidgetActions } from '@/glanceable-ios/widget-actions';
import { appShellHandoffUrl } from '@/lib/app-shell-handoff';
import { type AgentsView, parseAgentsViewParam } from '@/lib/agents-view';
import {
  getGitHubInstallReturnOutcome,
  type GitHubInstallReturnOutcome,
  subscribeToGitHubInstallReturnOutcome,
} from '@/lib/github-install-return';
import { recoverGlanceableActivityKit } from '@/lib/glanceable/activity-kit-prompt';

export type GitHubInstallOutcomeAlertButton = {
  text: string;
  onPress?: () => void;
};

export type GitHubInstallOutcomeAlert = {
  title: string;
  message: string;
  buttons: GitHubInstallOutcomeAlertButton[];
};

/**
 * C13 plan outcome states for the agents tab: happy, retryable unhappy,
 * non-retryable unhappy, and empty (no outcome → null, no alert).
 * The retryable state wires `onRetry` onto the `Try again` button so the
 * alert is a real recovery action, not an inert dismiss.
 */
export function buildGitHubInstallOutcomeAlert(
  result: GitHubInstallReturnOutcome,
  onRetry: () => void
): GitHubInstallOutcomeAlert | null {
  if (!result) {
    return null;
  }

  switch (result.kind) {
    case 'success': {
      return {
        title: i18n.t('agents.githubInstall.installedTitle'),
        message: i18n.t('agents.githubInstall.installedMessage'),
        buttons: [{ text: i18n.t('common.continue') }],
      };
    }
    case 'pending': {
      return {
        title: i18n.t('agents.githubInstall.pendingTitle'),
        message: i18n.t('agents.githubInstall.pendingMessage'),
        buttons: [{ text: i18n.t('common.done') }],
      };
    }
    case 'error': {
      if (result.code === 'install_state_user_mismatch') {
        return {
          title: i18n.t('agents.githubInstall.accountMismatchTitle'),
          message: i18n.t('agents.githubInstall.accountMismatchMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      if (result.code === 'not_installation_admin') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.notAdminMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      if (result.code === 'installation_already_claimed') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.alreadyClaimedMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      if (result.code === 'installation_unavailable') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.installationUnavailableMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      // The organization already holds a connection, so reinstalling from the
      // same entry reaches the same refusal; a retry would only reopen it.
      if (result.code === 'multiple_installations_disabled') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.multipleInstallationsMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      // An existing installation holds the organization's slot, so a retry from
      // the app is refused by the same rule; the copy names the removal on the
      // web organization page instead of offering that retry.
      if (result.code === 'github_installation_blocked') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.blockedByExistingInstallationMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      return {
        title: i18n.t('agents.githubInstall.didNotCompleteTitle'),
        message: i18n.t('agents.githubInstall.didNotCompleteMessage'),
        buttons: [{ text: i18n.t('common.tryAgain'), onPress: onRetry }],
      };
    }
    default: {
      return null;
    }
  }
}

/**
 * Recovery for a retryable installation outcome: the consumed install state
 * token is single-use, so mint a fresh shell hand-off and reopen the install
 * flow. The flow returns to /cloud/sessions so the outcome can reach this tab
 * again.
 *
 * When the original outcome was org-scoped, the retry hands off with the same
 * organizationId so the GitHub install stays on the original organization
 * owner.
 */
async function retryGitHubInstall(organizationId?: string): Promise<void> {
  try {
    const url = await appShellHandoffUrl({
      page: 'github-app',
      ...(organizationId ? { organizationId } : {}),
    });
    await (Platform.OS === 'android'
      ? WebBrowser.openBrowserAsync(url)
      : WebBrowser.openAuthSessionAsync(url));
  } catch {
    // Mint or browser failure is retryable: keep a working retry action so
    // the user can recover without restarting the whole install flow.
    Alert.alert(
      i18n.t('agents.githubInstall.couldNotOpenTitle'),
      i18n.t('agents.githubInstall.couldNotOpenMessage'),
      [{ text: i18n.t('common.tryAgain'), onPress: () => void retryGitHubInstall(organizationId) }],
      // Android back dismisses; reopening the flow retries the same way.
      { cancelable: true }
    );
  }
}

export default function AgentSessionList() {
  const router = useRouter();
  // A link names the view it wants (`…/(2_agents)?view=todos`), and that name is
  // a payload for one arrival, not tab state: the screen reads it into the view
  // it shows and clears it, and the segment a person presses only changes that
  // view. It must not stay on the route: Expo Router merges a bare string href
  // into the target's existing params, so a `view` left behind would follow
  // every later navigation to this tab and show To-dos to a destination that
  // promised the sessions list — the reason `AGENTS_SESSIONS_INDEX_HREF` clears
  // `status` on the way in.
  const params = useLocalSearchParams<{ view?: string | string[] }>();
  const [view, setView] = useState<AgentsView>(() => parseAgentsViewParam(params.view));
  const linkedView = params.view === undefined ? null : parseAgentsViewParam(params.view);
  useEffect(() => {
    if (linkedView === null) {
      return;
    }
    // A second link while the tab is mounted is a new answer rather than the
    // one the first link gave.
    setView(linkedView);
    // `setParams` clears the marker through the navigation container, which is
    // not guaranteed to reach this screen's params; the latch above keeps an
    // uncleared marker from reading as a new arrival on every render.
    router.setParams({ view: undefined });
  }, [linkedView, router]);
  const consumeReturnOutcome = useCallback(() => {
    const result = getGitHubInstallReturnOutcome();
    const alert = buildGitHubInstallOutcomeAlert(result, () => {
      void retryGitHubInstall(result?.organizationId);
    });
    if (alert) {
      // Android back dismisses; the outcome alerts are informational and the
      // retry flow re-arms from the tab.
      Alert.alert(alert.title, alert.message, alert.buttons, { cancelable: true });
    }
  }, []);

  useEffect(() => {
    consumeReturnOutcome();
    return subscribeToGitHubInstallReturnOutcome(consumeReturnOutcome);
  }, [consumeReturnOutcome]);

  // Only tab focus can show the one-time alert. Settings can return without
  // changing route focus, so also retry recovery when the app becomes active.
  useFocusEffect(
    useCallback(() => {
      void recoverGlanceableActivityKit();
      // A widget press that patched its marker before JS subscribed is picked
      // up here: the intent cannot run this JS itself, so the foreground is
      // the first moment the press can be answered. The marker rides the iOS
      // widget timeline, so the sweep finds nothing on Android and the same
      // call runs unchanged on both platforms.
      void runPendingWidgetActions();
      const subscription = AppState.addEventListener('change', state => {
        if (state === 'active') {
          void recoverGlanceableActivityKit();
          void runPendingWidgetActions();
        }
      });
      return () => {
        subscription.remove();
      };
    }, [])
  );

  const tabHeader = <AgentsViewSegment value={view} onChange={setView} />;
  return view === 'sessions' ? (
    <AgentSessionListScreen tabHeader={tabHeader} />
  ) : (
    <TodoListsScreen tabHeader={tabHeader} />
  );
}
