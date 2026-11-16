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
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { WEB_BASE_URL } from '@/lib/config';
import { bitbucketRepair } from '@/lib/code-reviewer-bitbucket';
import { openExternalUrl } from '@/lib/external-link';
import { notificationHaptic } from '@/lib/haptics';
import { useBitbucketIntegrationStatus, useBitbucketReadiness } from '@/lib/hooks/use-bitbucket';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { getIntegrationPageUrl } from '@/lib/integration-urls';
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
  // The readiness read describes workspace access tokens only, so this is what
  // tells a Bitbucket OAuth connection apart from a workspace with none.
  const status = useBitbucketIntegrationStatus(scope);
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
  const repair =
    readiness.data === undefined ? null : bitbucketRepair(readiness.data, status.data ?? null);
  // A workspace connected through Bitbucket OAuth has no token integration to
  // name, so the sheet is about the connection itself rather than about a form.
  const managesExisting = repair?.kind === 'manage-connection';
  let title = t('prReview.connect.reconnectTitleBitbucket');
  let deniedDescription = t('prReview.connect.gitlabReconnectAdminOnlyDescription');
  if (managesExisting) {
    title = t('agentChat.repoPicker.platformBitbucket');
    deniedDescription = t('integrations.managedByOwner');
  } else if (integrationId === null) {
    title = t('common.connectBitbucket');
    deniedDescription = t('codeReviewer.bitbucket.notConnectedReadOnly');
  }

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
        <PermissionDenied description={deniedDescription} />
      </>
    );
  }

  // The connect mutation refuses a second Bitbucket integration for the same
  // organization, and a Bitbucket OAuth connection can only be changed on the
  // page that runs its callback, so the sheet names that page rather than a
  // form whose submit the server would refuse.
  if (managesExisting) {
    return (
      <>
        <SheetTitle title={title} />
        <View className="gap-4 px-6 pt-2 pb-8">
          <Text variant="muted" className="text-sm">
            {t('organization.settingsOnWeb.integrations')}
          </Text>
          <Button
            variant="outline"
            onPress={() => {
              void openExternalUrl(getIntegrationPageUrl(WEB_BASE_URL, 'bitbucket', scope), {
                label: t('common.manageOnWeb'),
              });
            }}
          >
            <Text>{t('common.manageOnWeb')}</Text>
          </Button>
        </View>
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
