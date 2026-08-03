import { type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ExternalLink, RefreshCw } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type RepositorySectionView } from './new-session-repository-state';

type RepositoryItem = { fullName: string; isPrivate: boolean };

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  view: RepositorySectionView;
  isRetrying: boolean;
  onChange: (value: string) => void;
  onOpenGitHubIntegration: () => void;
  onRefreshRepos: () => void;
  repositories: RepositoryItem[];
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

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">Repository</Text>
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
            title="Couldn't load repositories"
            message="Check your connection and try again."
            onRetry={onRefreshRepos}
            isRetrying={isRetrying}
          />
        );
      }

      case 'connect': {
        return (
          <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">Connect GitHub</Text>
              <Text variant="muted">
                Connect GitHub in your browser, then return here to pick a repository.
              </Text>
            </View>
            <View className="flex-row gap-2">
              <Button variant="outline" className="flex-1" onPress={onOpenGitHubIntegration}>
                <ExternalLink size={16} color={colors.foreground} />
                <Text>Open GitHub</Text>
              </Button>
              <Button
                variant="outline"
                size="icon"
                onPress={onRefreshRepos}
                disabled={isRetrying}
                accessibilityLabel="Refresh repositories"
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
                We can't see your GitHub connection yet
              </Text>
              <Text variant="muted">
                If you installed or configured the Kilo GitHub App, check again — or make sure it
                was installed for this account/organization.
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
                <Text>Check again</Text>
              </Button>
              <Button
                variant="outline"
                size="icon"
                onPress={onOpenGitHubIntegration}
                accessibilityLabel="Open GitHub"
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
              <Text className="text-sm font-semibold text-foreground">GitHub connected</Text>
              <Text variant="muted">
                No repositories visible. Check repository access for the Kilo GitHub App, then
                refresh.
              </Text>
            </View>
            <View className="flex-row gap-2">
              <Button
                variant="outline"
                size="icon"
                onPress={onRefreshRepos}
                disabled={isRetrying}
                accessibilityLabel="Refresh repositories"
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
