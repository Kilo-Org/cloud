import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';

import { BitbucketConnectForm } from '@/components/code-reviewer/bitbucket-connect-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { SheetScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { bitbucketRepair } from '@/lib/code-reviewer-bitbucket';
import { notificationHaptic } from '@/lib/haptics';
import { useBitbucketIntegrationStatus, useBitbucketReadiness } from '@/lib/hooks/use-bitbucket';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { isPermissionDeniedError, trpcErrorVariant } from '@/lib/trpc-error';

/**
 * The one form that connects the organization's Bitbucket workspace, in the
 * sheet every entry point pushes: the code reviewer's setup states, the new
 * session repository section, the PR review connect gate and the integrations
 * hub. A workspace that already has an integration replaces its token here
 * instead of connecting twice, which the server refuses.
 */
export function BitbucketConnectSheet({ scope }: Readonly<{ scope: string | undefined }>) {
  const router = useRouter();
  const { t } = useTranslation();
  // The route is a full-window modal on Android and a formSheet on iOS, so the
  // surface reaches the window top there and the header clears the status bar
  // itself; the native sheet presents below it and the header reserves nothing.
  return (
    <>
      {/* Without a scope there is no organization to name, and the boundary
          explains which selection is missing instead of leaving the sheet
          blank. It still needs the close control, because this branch renders
          before any scope-dependent state exists. */}
      {scope === undefined ? (
        <>
          <SheetHeader
            title={t('agentChat.repoPicker.platformBitbucket')}
            variant="close"
            topInset="android-window-top"
            onDone={() => {
              router.back();
            }}
          />
          <OrganizationBoundary />
        </>
      ) : (
        <ScopedBitbucketConnectSheet scope={scope} />
      )}
    </>
  );
}

function ScopedBitbucketConnectSheet({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  // The token field is the sheet's only draft, and the header close control,
  // the Android Back and the back gesture would drop whatever is typed in it.
  const guard = useMetadataLeaveGuard({ enabled: true });
  const { role, org, isResolving, isError } = useOrgBoundary(scope);
  const readiness = useBitbucketReadiness(scope);
  // The readiness read describes workspace access tokens only, so this is what
  // tells a Bitbucket OAuth connection apart from a workspace with none.
  const status = useBitbucketIntegrationStatus(scope);
  // The contract the connect mutations enforce (`organizationBillingProcedure`),
  // so a deep link never offers a submit the server would refuse.
  const canManage = canManageOrganizationBilling(role);

  const integrationId = readiness.data?.integrationId ?? null;
  const repair = readiness.data === undefined ? null : bitbucketRepair(readiness.data, status.data);
  // A workspace connected through Bitbucket OAuth has no token integration to
  // name, so the sheet is about the connection itself rather than about a form.
  const managesExisting = repair?.kind === 'manage-connection';
  // Until the two reads settle the sheet cannot know which repair it will
  // offer, and a failed read leaves the answer unknown, not "not connected":
  // the title names the platform in both cases instead of promising a form the
  // sheet may not render.
  const readsSettled =
    !isResolving &&
    !readiness.isPending &&
    !status.isPending &&
    !(readiness.isError && readiness.data == null) &&
    !(status.isError && status.data == null);
  let title = t('agentChat.repoPicker.platformBitbucket');
  let deniedDescription = t('prReview.connect.gitlabReconnectAdminOnlyDescription');
  if (readsSettled) {
    if (managesExisting) {
      deniedDescription = t('integrations.managedByOwner');
    } else if (integrationId === null) {
      title = t('common.connectBitbucket');
      deniedDescription = t('codeReviewer.bitbucket.notConnectedReadOnly');
    } else {
      title = t('prReview.connect.reconnectTitleBitbucket');
    }
  }

  // One body per state, so the guard's confirmation renders beside all of them:
  // a read that answers while a token is typed can replace the form with an
  // error, and a Back there must still find a prompt to answer.
  const renderBody = (): ReactNode => {
    if (isResolving || readiness.isPending || status.isPending) {
      return (
        <SheetScrollView
          className="flex-1 bg-background"
          contentContainerClassName={SCREEN_BODY_CLASS}
        >
          {/* The header already paints the title, so the body reserves the
              form's own blocks: the description, then the field and its action. */}
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

    // An unanswered status read is not "no integration": it is the only read
    // that can name a Bitbucket OAuth connection, so a failure asks again
    // instead of offering a token form the server would refuse.
    if (status.isError && status.data == null) {
      return isPermissionDeniedError(status.error) ? (
        <PermissionDenied
          description={t('prReview.connect.bitbucketAdminOnlyDescription')}
          showBack={false}
        />
      ) : (
        <QueryError
          className="bg-background"
          variant={trpcErrorVariant(status.error)}
          onRetry={() => void status.refetch()}
          isRetrying={status.isFetching}
        />
      );
    }

    if (readiness.isError && readiness.data == null) {
      return isPermissionDeniedError(readiness.error) ? (
        <PermissionDenied
          description={t('prReview.connect.bitbucketAdminOnlyDescription')}
          showBack={false}
        />
      ) : (
        <QueryError
          className="bg-background"
          variant={trpcErrorVariant(readiness.error)}
          onRetry={() => void readiness.refetch()}
          isRetrying={readiness.isFetching}
        />
      );
    }

    if (!canManage) {
      return <PermissionDenied description={deniedDescription} showBack={false} />;
    }

    // The connect mutation refuses a second Bitbucket integration for the same
    // organization, and a Bitbucket OAuth connection can only be changed on the
    // web page that runs its callback — which the app may not link to, so the
    // sheet states where the connection is managed and offers no action.
    if (managesExisting) {
      return (
        <View className="px-4 pt-3">
          <Text variant="muted" className="text-sm">
            {t('codeReviewer.bitbucketConnect.managedOnWeb')}
          </Text>
        </View>
      );
    }

    return (
      <SheetScrollView
        className="flex-1 bg-background"
        contentContainerClassName={SCREEN_BODY_CLASS}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <BitbucketConnectForm
          scope={scope}
          integrationId={integrationId}
          onDirtyChange={guard.handleDirtyChange}
          onConnected={() => {
            notificationHaptic(Haptics.NotificationFeedbackType.Success);
            announcingToast.success(t('common.bitbucketConnected'));
            // The token was accepted, so there is no draft left to confirm.
            guard.leaveWithoutAsking(() => {
              router.back();
            });
          }}
        />
      </SheetScrollView>
    );
  };

  return (
    <>
      {/* The sheet's own header is the shared one: the title stays pinned above
          the scroll body in every state, and the X is the modal's one visible
          dismissal. It dispatches the same route removal Back does, so the
          leave guard answers it while a token is typed. */}
      <SheetHeader
        title={title}
        variant="close"
        topInset="android-window-top"
        onDone={() => {
          router.back();
        }}
      />
      {renderBody()}
      {guard.dialog}
    </>
  );
}
