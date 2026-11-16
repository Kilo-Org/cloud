import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
import { GitLabIntegrationDetails } from '@/components/integrations/GitLabIntegrationDetails';
import { SlackIntegrationDetails } from '@/components/integrations/SlackIntegrationDetails';
import { LinearIntegrationDetails } from '@/components/integrations/LinearIntegrationDetails';
import { DiscordIntegrationDetails } from '@/components/integrations/DiscordIntegrationDetails';
import {
  APP_SHELL_PREFIX,
  buildAppShellConnectPath,
  type AppShellPlatform,
} from '@/lib/app-shell/shell-paths';

type AppShellIntegrationDetailsProps = {
  platform: AppShellPlatform;
  organizationId?: string;
  /** True for an organization owner/admin, which Slack shows as edit authority. */
  canManage: boolean;
  success: boolean;
  error?: string;
  /** The shell page an install started here returns to. */
  selfPath: string;
};

/**
 * The provider detail the shell renders. It is the same component the full web
 * page renders, pointed at the shell's own OAuth start route and, inside the
 * shell, without the links that leave it.
 */
export function AppShellIntegrationDetails({
  platform,
  organizationId,
  canManage,
  success,
  error,
  selfPath,
}: AppShellIntegrationDetailsProps) {
  switch (platform) {
    case 'github':
      return (
        <GitHubIntegrationDetails
          organizationId={organizationId}
          fromApp
          success={false}
          appReturnPath={selfPath}
          installStartPath={`${APP_SHELL_PREFIX}/github-app/start`}
        />
      );
    case 'gitlab':
      return (
        <GitLabIntegrationDetails
          organizationId={organizationId}
          success={success}
          error={error}
          connectPath={buildAppShellConnectPath('gitlab', { organizationId })}
          shell
        />
      );
    case 'slack':
      return (
        <SlackIntegrationDetails
          organizationId={organizationId}
          success={success}
          error={error}
          canManage={canManage}
          connectPath={buildAppShellConnectPath('slack', { organizationId })}
        />
      );
    case 'linear':
      return (
        <LinearIntegrationDetails
          organizationId={organizationId}
          success={success}
          error={error}
          connectPath={buildAppShellConnectPath('linear', { organizationId })}
        />
      );
    case 'discord':
      return (
        <DiscordIntegrationDetails
          organizationId={organizationId}
          success={success}
          error={error}
        />
      );
  }
}
