import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { BitbucketSetupRecovery } from '@/components/code-reviewer/bitbucket-setup-recovery';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { GitMerge } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type BitbucketConnection, isWebManagedConnection } from '@/lib/code-reviewer-bitbucket';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

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
  // The body names the organization the web page manages the connection for,
  // read from the same membership row the rest of the screen uses. Until it
  // resolves the line holds the generic noun, so it never prints an unfilled
  // placeholder.
  const orgBoundary = useOrgBoundary(scope);
  const organizationName = orgBoundary.org?.organizationName;

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
    // The connection is read-only here, so the state says where it lives rather
    // than offering a token form the server would refuse. It draws through the
    // shared state so the glyph, the heading and the muted body keep the same
    // metrics and contrast as the screen's other states.
    return (
      <EmptyState
        icon={GitMerge}
        iconSize={28}
        title={t('codeReviewer.bitbucketConnect.managedOnWebTitle')}
        description={t('codeReviewer.bitbucketConnect.managedOnWebRepositories', {
          organization: organizationName ?? t('common.organization'),
        })}
      />
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
          readiness={readiness}
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
