import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  bitbucketConnectionFailure,
  type BitbucketFailure,
  type BitbucketReadiness,
  bitbucketRepair,
} from '@/lib/code-reviewer-bitbucket';
import { bitbucketConnectHref } from '@/lib/bitbucket-connect-navigation';
import { useRefreshBitbucketRepositories } from '@/lib/hooks/use-bitbucket';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { cn } from '@/lib/utils';

/**
 * The in-app repair for a Bitbucket workspace that is not ready: connect a
 * workspace, replace a token Bitbucket refused, or re-read the repository cache
 * of a workspace whose token still works. Both the code reviewer's repositories
 * screen and its overview setup card render this, so neither hands the browser a
 * page the app can now do itself.
 */
export function BitbucketSetupRecovery({
  scope,
  readiness,
  message,
  className,
}: Readonly<{
  scope: string;
  readiness: BitbucketReadiness;
  /** The state's own explanation, which names what the reader is missing. */
  message: string;
  className?: string;
}>) {
  const router = useRouter();
  const { t } = useTranslation();
  const refresh = useRefreshBitbucketRepositories(scope);
  const { feedback, begin } = useSurfaceFeedback<BitbucketFailure>();
  const repair = bitbucketRepair(readiness);
  const refreshing = feedback.status === 'pending';
  const failure = feedback.status === 'failed' ? feedback.failure : null;

  const refreshRepositories = (integrationId: string) => {
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    void (async () => {
      try {
        await refresh.mutateAsync({ integrationId });
        if (attempt.owns()) {
          // The hook has already invalidated the reads this card renders, so
          // the outcome shows as fresh rows rather than a phase here.
          attempt.abandon();
        }
      } catch (error) {
        if (attempt.owns()) {
          attempt.fail(bitbucketConnectionFailure(error, t));
        }
      }
    })();
  };

  const openConnect = () => {
    router.push(bitbucketConnectHref(scope));
  };

  return (
    <View className={cn('items-center gap-3 rounded-lg bg-secondary p-4', className)}>
      <Text className="text-center text-xs text-muted-foreground">{message}</Text>
      {failure === null ? actionBody() : failureBody(failure)}
    </View>
  );

  function actionBody() {
    if (repair.kind === 'refresh-repositories') {
      return (
        <Button
          variant="outline"
          size="sm"
          loading={refreshing}
          disabled={refreshing}
          onPress={() => {
            refreshRepositories(repair.integrationId);
          }}
        >
          <Text>{t('agentChat.newSession.refreshRepositories')}</Text>
        </Button>
      );
    }
    return (
      <Button variant="outline" size="sm" onPress={openConnect}>
        <Text>
          {repair.kind === 'connect'
            ? t('common.connectBitbucket')
            : t('prReview.connect.reconnectTitleBitbucket')}
        </Text>
      </Button>
    );
  }

  function failureBody(settled: BitbucketFailure) {
    const kind = settled.kind;
    switch (kind) {
      case 'retryable': {
        return (
          <>
            <AccessibleStatus message={settled.message} className="text-center text-sm" />
            <Button
              variant="outline"
              size="sm"
              loading={refreshing}
              disabled={refreshing}
              onPress={() => {
                if (repair.kind === 'refresh-repositories') {
                  refreshRepositories(repair.integrationId);
                  return;
                }
                openConnect();
              }}
            >
              <Text>{t('common.tryAgain')}</Text>
            </Button>
          </>
        );
      }
      case 'token-refused': {
        // The saved token is the reason the read failed, so the only action that
        // can succeed is a replacement token.
        return (
          <>
            <AccessibleStatus message={settled.message} className="text-center text-sm" />
            <Button variant="outline" size="sm" onPress={openConnect}>
              <Text>{t('prReview.connect.reconnectTitleBitbucket')}</Text>
            </Button>
          </>
        );
      }
      case 'role-refused':
      case 'connection-changed': {
        return <AccessibleStatus message={settled.message} className="text-center text-sm" />;
      }
      default: {
        return assertSurfaceFailureHandled(kind);
      }
    }
  }
}
