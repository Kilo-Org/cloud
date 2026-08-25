import { type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type RepoOption } from '@/lib/picker-bridge';
import { type RepositorySectionView } from './new-session-repository-state';

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  view: RepositorySectionView;
  isRetrying: boolean;
  onChange: (value: string) => void;
  onOpenGitHubIntegration: () => void;
  onRefreshRepos: () => void;
  repositories: RepoOption[];
  value: string;
};

/**
 * Repository picker and the optional GitHub integration card. Pulled out
 * of the route so the screen stays thin per `apps/mobile/AGENTS.md`. The
 * route owns the data and side effects; this view only renders them.
 */
export function NewSessionRepositorySection({
  disabled,
  view,
  isRetrying,
  onChange,
  onOpenGitHubIntegration,
  onRefreshRepos,
  repositories,
  value,
}: Readonly<NewSessionRepositorySectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.repository')}
      </Text>
      {renderBody()}
    </View>
  );

  function renderBody(): ReactNode {
    switch (view) {
      case 'error': {
        return (
          <QueryError
            placement="top"
            variant="server"
            title={t('agentChat.newSession.couldNotLoadRepositories')}
            message={t('agentChat.instancePicker.couldNotLoadDescription')}
            onRetry={onRefreshRepos}
            isRetrying={isRetrying}
          />
        );
      }

      case 'connect': {
        return (
          <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">
                {t('agentChat.newSession.connectGithub')}
              </Text>
              <Text variant="muted">{t('agentChat.newSession.connectGithubDescription')}</Text>
            </View>
            <View className="flex-row gap-2">
              <Button variant="outline" className="flex-1" onPress={onOpenGitHubIntegration}>
                <ExternalLink size={16} color={colors.foreground} />
                <Text>{t('agentChat.newSession.openGithub')}</Text>
              </Button>
              <Button
                variant="outline"
                size="icon"
                onPress={onRefreshRepos}
                disabled={isRetrying}
                accessibilityLabel={t('agentChat.newSession.refreshRepositories')}
              >
                {isRetrying ? (
                  <ActivityIndicator size="small" color={colors.foreground} />
                ) : (
                  <RefreshCw size={16} color={colors.foreground} />
                )}
              </Button>
            </View>
          </View>
        );
      }

      case 'connect-fallback': {
        return (
          <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">
                {t('agentChat.newSession.githubConnectionNotVisible')}
              </Text>
              <Text variant="muted">
                {t('agentChat.newSession.githubConnectionNotVisibleDescription')}
              </Text>
            </View>
            <View className="flex-row gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onPress={onRefreshRepos}
                disabled={isRetrying}
              >
                {isRetrying ? (
                  <ActivityIndicator size="small" color={colors.foreground} />
                ) : (
                  <RefreshCw size={16} color={colors.foreground} />
                )}
                <Text>{t('agentChat.newSession.checkAgain')}</Text>
              </Button>
              <Button
                variant="outline"
                size="icon"
                onPress={onOpenGitHubIntegration}
                accessibilityLabel={t('agentChat.newSession.openGithub')}
              >
                <ExternalLink size={16} color={colors.foreground} />
              </Button>
            </View>
          </View>
        );
      }

      case 'connected-empty': {
        return (
          <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">
                {t('agentChat.newSession.githubConnected')}
              </Text>
              <Text variant="muted">{t('agentChat.newSession.noRepositoriesVisible')}</Text>
            </View>
            <View className="flex-row gap-2">
              <Button
                variant="outline"
                size="icon"
                onPress={onRefreshRepos}
                disabled={isRetrying}
                accessibilityLabel={t('agentChat.newSession.refreshRepositories')}
              >
                {isRetrying ? (
                  <ActivityIndicator size="small" color={colors.foreground} />
                ) : (
                  <RefreshCw size={16} color={colors.foreground} />
                )}
              </Button>
            </View>
          </View>
        );
      }

      case 'loading':
      case 'repos': {
        return (
          <RepoSelector
            value={value}
            repositories={repositories}
            isLoading={view === 'loading'}
            onChange={onChange}
            disabled={disabled}
          />
        );
      }

      default: {
        return null;
      }
    }
  }
}
