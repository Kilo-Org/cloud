import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { BitbucketSetupRecovery } from '@/components/code-reviewer/bitbucket-setup-recovery';
import { QueryError } from '@/components/query-error';
import { Text } from '@/components/ui/text';
import { type BitbucketConnection, isWebManagedConnection } from '@/lib/code-reviewer-bitbucket';

/**
 * The body the repositories screen paints for a Bitbucket connection that holds
 * no repository snapshot. The readiness read models workspace access tokens
 * only, so the connection decided here also carries the OAuth authorization:
 * that connection has no token to re-read, which is why the notice says where it
 * is managed instead of offering a recovery form the server would refuse.
 */
export function BitbucketRepositoriesState({
  scope,
  connection,
  onRetry,
}: Readonly<{
  scope: string;
  /** The connection both reads decide. */
  connection: BitbucketConnection;
  /** A retry re-reads the repository snapshot with the connection. */
  onRetry: () => void;
}>) {
  const { t } = useTranslation();

  if (connection.kind === 'error') {
    return (
      <QueryError
        variant={connection.variant}
        placement="center"
        onRetry={
          connection.permanent
            ? undefined
            : () => {
                connection.refetch();
                onRetry();
              }
        }
        isRetrying={connection.isRetrying}
      />
    );
  }

  if (isWebManagedConnection(connection)) {
    return (
      <CenteredState contentContainerClassName="px-4">
        <Text variant="muted" className="text-center text-xs">
          {t('codeReviewer.bitbucketConnect.managedOnWeb')}
        </Text>
      </CenteredState>
    );
  }

  const readiness =
    connection.kind === 'token-connected' || connection.kind === 'not-connected'
      ? connection.readiness
      : null;
  return (
    <CenteredState contentContainerClassName="px-4">
      {readiness ? (
        <BitbucketSetupRecovery
          scope={scope}
          readiness={connection.readiness}
          message={t('common.couldNotLoadRepositories')}
        />
      ) : (
        <View className="px-2">
          <Text variant="muted" className="text-center text-xs">
            {t('common.couldNotLoadRepositories')}
          </Text>
        </View>
      )}
    </CenteredState>
  );
}
