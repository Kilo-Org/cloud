import { ActivityIndicator, View } from 'react-native';
import { ExternalLink, RefreshCw } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { shouldShowRepositoryError } from './new-session-repository-state';

type RepositoryItem = { fullName: string; isPrivate: boolean };

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  isError: boolean;
  isLoading: boolean;
  isRefetching: boolean;
  onChange: (value: string) => void;
  onOpenGitHubIntegration: () => void;
  onRefetch: () => void;
  repositories: RepositoryItem[];
  showGitHubIntegrationPrompt: boolean;
  value: string;
};

/**
 * Repository picker and the optional GitHub integration card. Pulled out
 * of the route so the screen stays thin per `apps/mobile/AGENTS.md`. The
 * route owns the data and side effects; this view only renders them.
 */
export function NewSessionRepositorySection({
  disabled,
  isError,
  isLoading,
  isRefetching,
  onChange,
  onOpenGitHubIntegration,
  onRefetch,
  repositories,
  showGitHubIntegrationPrompt,
  value,
}: Readonly<NewSessionRepositorySectionProps>) {
  const colors = useThemeColors();
  const showError = shouldShowRepositoryError({
    isError,
    repositoryCount: repositories.length,
  });

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">Repository</Text>
      {showError ? (
        <QueryError
          placement="top"
          variant="server"
          title="Couldn't load repositories"
          message="Check your connection and try again."
          onRetry={onRefetch}
          isRetrying={isRefetching}
        />
      ) : (
        <>
          <RepoSelector
            value={value}
            repositories={repositories}
            isLoading={isLoading}
            onChange={onChange}
            disabled={disabled}
          />
          {showGitHubIntegrationPrompt ? (
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
                  onPress={onRefetch}
                  disabled={isRefetching}
                  accessibilityLabel="Refresh repositories"
                >
                  {isRefetching ? (
                    <ActivityIndicator size="small" color={colors.foreground} />
                  ) : (
                    <RefreshCw size={16} color={colors.foreground} />
                  )}
                </Button>
              </View>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
