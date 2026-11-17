import 'server-only';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { appShellRouter } from '@/routers/app-shell-router';
import { discordRouter } from '@/routers/discord-router';
import { githubAppsRouter } from '@/routers/github-apps-router';
import { gitlabRouter } from '@/routers/gitlab-router';
import { linearRouter } from '@/routers/linear-router';
import { modelsRouter } from '@/routers/models-router';
import { organizationsRouter } from '@/routers/organizations/organization-router';
import { slackRouter } from '@/routers/slack-router';
import { userRouter } from '@/routers/user-router';

/**
 * The procedures `/app-shell/api/trpc` publishes.
 *
 * The shell runs in the native app's in-app browser with a cookie scoped to
 * `/app-shell` as its whole identity, so whatever this entry point mounts is
 * reachable by anyone holding a shell session. Mounting `rootRouter` here would
 * publish the whole web API — billing included — to that credential, which no
 * shell page needs. This router therefore holds exactly the procedures the
 * shell pages and the components they render call, and nothing else:
 *
 * - `models.selectorList`: the model picker on the integration pages.
 * - `user.*`: the connected-accounts page's provider list, link and unlink,
 *   plus the Discord guild status card.
 * - `organizations.withMembers`, `seats`,
 *   `subscription.getLatestSeatPurchaseStatus`: the SSO and data-collection
 *   cards, which load the organization row and its trial/read-only status.
 * - `organizations.sso.*` and `organizations.settings.updateDataCollection`:
 *   the SSO and data-collection cards' own reads and writes.
 * - `githubApps.*`, `gitlab.*`, `slack.*`, `linear.*`, `discord.*`: the
 *   provider detail pages' installation reads and connection actions. The
 *   organization-only GitHub procedures are absent because the shell suppresses
 *   the components that call them.
 * - `appShell.mintHandoff`: the bridge the app uses to open a shell page.
 *
 * Adding a procedure here widens that credential, so a page that needs a new
 * one must add it deliberately, with the same auth middleware it already uses.
 */
export const appShellProceduresRouter = createTRPCRouter({
  appShell: {
    mintHandoff: appShellRouter.mintHandoff,
  },
  models: {
    selectorList: modelsRouter.selectorList,
  },
  user: {
    getAuthProviders: userRouter.getAuthProviders,
    linkAuthProvider: userRouter.linkAuthProvider,
    unlinkAuthProvider: userRouter.unlinkAuthProvider,
    getDiscordGuildStatus: userRouter.getDiscordGuildStatus,
    verifyDiscordGuildMembership: userRouter.verifyDiscordGuildMembership,
  },
  organizations: {
    withMembers: organizationsRouter.withMembers,
    seats: organizationsRouter.seats,
    subscription: {
      getLatestSeatPurchaseStatus: organizationsRouter.subscription.getLatestSeatPurchaseStatus,
    },
    sso: {
      getConfig: organizationsRouter.sso.getConfig,
      generateAdminPortalLink: organizationsRouter.sso.generateAdminPortalLink,
    },
    settings: {
      updateDataCollection: organizationsRouter.settings.updateDataCollection,
    },
  },
  githubApps: {
    getAppType: githubAppsRouter.getAppType,
    getInstallation: githubAppsRouter.getInstallation,
    checkUserPendingInstallation: githubAppsRouter.checkUserPendingInstallation,
    listIntegrations: githubAppsRouter.listIntegrations,
    mintInstallState: githubAppsRouter.mintInstallState,
    cancelPendingInstallation: githubAppsRouter.cancelPendingInstallation,
    refreshInstallation: githubAppsRouter.refreshInstallation,
    uninstallApp: githubAppsRouter.uninstallApp,
    updateModel: githubAppsRouter.updateModel,
    devAddInstallation: githubAppsRouter.devAddInstallation,
  },
  gitlab: {
    getInstallation: gitlabRouter.getInstallation,
    validateInstance: gitlabRouter.validateInstance,
    validatePAT: gitlabRouter.validatePAT,
    connectWithPAT: gitlabRouter.connectWithPAT,
    disconnect: gitlabRouter.disconnect,
    refreshRepositories: gitlabRouter.refreshRepositories,
  },
  slack: {
    getInstallation: slackRouter.getInstallation,
    uninstallApp: slackRouter.uninstallApp,
    testConnection: slackRouter.testConnection,
    updateModel: slackRouter.updateModel,
    devRemoveDbRowOnly: slackRouter.devRemoveDbRowOnly,
  },
  linear: {
    getInstallation: linearRouter.getInstallation,
    uninstallApp: linearRouter.uninstallApp,
    updateModel: linearRouter.updateModel,
    devRemoveDbRowOnly: linearRouter.devRemoveDbRowOnly,
  },
  discord: {
    getInstallation: discordRouter.getInstallation,
    uninstallApp: discordRouter.uninstallApp,
    testConnection: discordRouter.testConnection,
    updateModel: discordRouter.updateModel,
    devRemoveDbRowOnly: discordRouter.devRemoveDbRowOnly,
  },
});
