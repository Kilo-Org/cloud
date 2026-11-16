import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';

import { BitbucketConnectForm } from '@/components/code-reviewer/bitbucket-connect-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { SheetScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { notificationHaptic } from '@/lib/haptics';
import { useBitbucketReadiness } from '@/lib/hooks/use-bitbucket';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { isPermissionDeniedError, trpcErrorVariant } from '@/lib/trpc-error';

/**
 * The one form that connects the organization's Bitbucket workspace, in the
 * sheet every entry point pushes: the code reviewer's setup states, the new
 * session repository section, the PR review connect gate and the integrations
 * hub. A workspace that already has an integration replaces its token here
 * instead of connecting twice, which the server refuses.
 */
export function BitbucketConnectSheet({ scope }: Readonly<{ scope: string | undefined }>) {
  // Without a scope there is no organization to name, and the boundary explains
  // which selection is missing instead of leaving the sheet blank.
  if (scope === undefined) {
    return <OrganizationBoundary />;
  }
  return <ScopedBitbucketConnectSheet scope={scope} />;
}

function ScopedBitbucketConnectSheet({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { role, org, isResolving, isError } = useOrgBoundary(scope);
  const readiness = useBitbucketReadiness(scope);
  // The contract the connect mutations enforce (`organizationBillingProcedure`),
  // so a deep link never offers a submit the server would refuse.
  const canManage = canManageOrganizationBilling(role);

  if (isResolving || readiness.isPending) {
    return (
      <SheetScrollView
        className="flex-1 bg-background"
        contentContainerClassName="gap-6 px-6 pt-4 pb-8"
      >
        <Skeleton className="mx-auto h-5 w-40 rounded" />
        <View className="gap-2">
          <Skeleton className="h-3.5 w-full rounded" />
          <Skeleton className="h-3.5 w-4/5 rounded" />
        </View>
        <View className="gap-1.5">
          <Skeleton className="h-3.5 w-32 rounded" />
          <Skeleton className="h-11 rounded-md" />
        </View>
        <Skeleton className="h-11 rounded-md" />
      </SheetScrollView>
    );
  }

  if (isError || org == null) {
    return <OrganizationBoundary organizationIdOverride={scope} />;
  }

  const integrationId = readiness.data?.integrationId ?? null;
  const title =
    integrationId === null
      ? t('common.connectBitbucket')
      : t('prReview.connect.reconnectTitleBitbucket');

  if (readiness.isError && readiness.data == null) {
    return (
      <>
        <SheetTitle title={title} />
        {isPermissionDeniedError(readiness.error) ? (
          <PermissionDenied description={t('prReview.connect.bitbucketAdminOnlyDescription')} />
        ) : (
          <QueryError
            className="bg-background"
            variant={trpcErrorVariant(readiness.error)}
            onRetry={() => void readiness.refetch()}
            isRetrying={readiness.isFetching}
          />
        )}
      </>
    );
  }

  if (!canManage) {
    return (
      <>
        <SheetTitle title={title} />
        <PermissionDenied
          description={
            integrationId === null
              ? t('codeReviewer.bitbucket.notConnectedReadOnly')
              : t('prReview.connect.gitlabReconnectAdminOnlyDescription')
          }
        />
      </>
    );
  }

  return (
    <SheetScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 px-6 pt-4 pb-8"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <SheetTitle title={title} />
      <BitbucketConnectForm
        scope={scope}
        integrationId={integrationId}
        onConnected={() => {
          notificationHaptic(Haptics.NotificationFeedbackType.Success);
          announcingToast.success(t('common.bitbucketConnected'));
          router.back();
        }}
      />
    </SheetScrollView>
  );
}

function SheetTitle({ title }: Readonly<{ title: string }>) {
  return (
    <View collapsable={false} className="bg-background px-6 pt-4">
      <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
    </View>
  );
}
