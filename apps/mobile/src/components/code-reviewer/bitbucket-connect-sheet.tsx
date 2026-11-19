import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type TFunction } from 'i18next';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';

import { BitbucketConnectForm } from '@/components/code-reviewer/bitbucket-connect-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { SheetScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { bitbucketRepair } from '@/lib/code-reviewer-bitbucket';
import { useSheetHeaderTopClearance } from '@/lib/form-sheet';
import { notificationHaptic } from '@/lib/haptics';
import { useBitbucketIntegrationStatus, useBitbucketReadiness } from '@/lib/hooks/use-bitbucket';
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
  // The route presents as a full-window modal on Android, so the surface reaches
  // the window top there and must clear the status bar itself; the iOS formSheet
  // presents below it and reserves nothing. The rule resolves both from the same
  // inputs the sheet headers use, and it is applied once here so every state of
  // the sheet — the boundary, the loading skeleton and the form — clears it.
  const windowTopClearance = useSheetHeaderTopClearance('android-window-top');
  const { t } = useTranslation();
  return (
    <View
      className="flex-1 bg-background"
      style={windowTopClearance > 0 ? { paddingTop: windowTopClearance } : undefined}
    >
      {/* Without a scope there is no organization to name, and the boundary
          explains which selection is missing instead of leaving the sheet
          blank. It still needs the Android close control, because this branch
          renders before any scope-dependent state exists. */}
      {scope === undefined ? (
        <>
          <SurfaceHeader title={t('agentChat.repoPicker.platformBitbucket')} />
          <OrganizationBoundary />
        </>
      ) : (
        <ScopedBitbucketConnectSheet scope={scope} />
      )}
    </View>
  );
}

function ScopedBitbucketConnectSheet({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  // The token field is the sheet's only draft, and the header back arrow, the
  // Android Back and the back gesture would drop whatever is typed in it.
  const guard = useMetadataLeaveGuard({ enabled: true });
  const { role, org, isResolving, isError } = useOrgBoundary(scope);
  const readiness = useBitbucketReadiness(scope);
  // The readiness read describes workspace access tokens only, so this is what
  // tells a Bitbucket OAuth connection apart from a workspace with none.
  const status = useBitbucketIntegrationStatus(scope);
  // The contract the connect mutations enforce (`organizationBillingProcedure`),
  // so a deep link never offers a submit the server would refuse.
  const canManage = canManageOrganizationBilling(role);
  // The heading is one value for the whole surface, resolved from whatever the
  // reads have answered: a state that is still loading shows the platform name
  // rather than claiming a connection it has not read yet.
  const integrationId = readiness.data?.integrationId ?? null;
  const repair = readiness.data === undefined ? null : bitbucketRepair(readiness.data, status.data);
  // A workspace connected through Bitbucket OAuth has no token integration to
  // name, so the sheet is about the connection itself rather than about a form.
  const managesExisting = repair?.kind === 'manage-connection';
  const { title, deniedDescription } = bitbucketSheetCopy({
    t,
    integrationId,
    managesExisting,
    // A read that has not answered cannot claim a connection either way.
    resolved: readiness.data !== undefined && status.data !== undefined,
  });

  // One body per state, so the guard's confirmation renders beside all of them:
  // a read that answers while a token is typed can replace the form with an
  // error, and a Back there must still find a prompt to answer.
  const renderBody = (): ReactNode => {
    if (isResolving || readiness.isPending || status.isPending) {
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

    // An unanswered status read is not "no integration": it is the only read
    // that can name a Bitbucket OAuth connection, so a failure asks again
    // instead of offering a token form the server would refuse.
    if (status.isError && status.data == null) {
      return (
        <>
          <SheetTitle title={title} />
          {isPermissionDeniedError(status.error) ? (
            <PermissionDenied description={t('prReview.connect.bitbucketAdminOnlyDescription')} />
          ) : (
            <QueryError
              className="bg-background"
              variant={trpcErrorVariant(status.error)}
              onRetry={() => void status.refetch()}
              isRetrying={status.isFetching}
            />
          )}
        </>
      );
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
    // web page that runs its callback — which the app may not link to, so the
    // sheet states where the connection is managed and offers no action.
    if (managesExisting) {
      return (
        <>
          <SheetTitle title={title} />
          <View className="px-6 pt-2 pb-8">
            <Text variant="muted" className="text-sm">
              {t('codeReviewer.bitbucketConnect.managedOnWeb', {
                organization: org.organizationName,
              })}
            </Text>
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
          organizationName={org.organizationName}
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
      {/* The Android modal owns the whole window and has no native dismissal,
          so its header is a fixed sibling of the body: every state carries the
          same close control in the same place, and the form does not scroll the
          heading away. iOS keeps the formSheet's grabber and its centred title
          inside the form, so nothing moves there. */}
      <SurfaceHeader title={title} />
      {renderBody()}
      {guard.dialog}
    </>
  );
}

/**
 * The Android header of the modal: the sheet's heading plus the close control
 * that is this presentation's only visible dismissal. It renders nothing on the
 * iOS formSheet, which carries its own grabber and dismissal gesture and keeps
 * `SheetTitle` inside the form.
 *
 * The control dispatches the same route removal Back does, so the leave guard
 * answers it while a token is typed.
 */
function SurfaceHeader({ title }: Readonly<{ title: string }>) {
  const router = useRouter();
  if (Platform.OS !== 'android') {
    return null;
  }
  return (
    <View className="bg-background">
      <ScreenHeader
        title={title}
        modal
        // The surface pads the status bar itself, so the header must not.
        safeAreaTop={false}
        showBackButton
        backIcon="close"
        onBack={() => {
          router.back();
        }}
      />
    </View>
  );
}

type BitbucketSheetCopy = Readonly<{ title: string; deniedDescription: string }>;

/**
 * The sheet's heading and the sentence that explains a refusal, from the
 * integration facts the reads answered.
 *
 * Kept out of the component so the values are plain branches: the component
 * renders one surface whose heading must not depend on which body branch is on
 * screen, and a state whose reads have not answered names the platform rather
 * than claiming a connection it has not read.
 */
function bitbucketSheetCopy(input: {
  t: TFunction;
  integrationId: string | null;
  managesExisting: boolean;
  resolved: boolean;
}): BitbucketSheetCopy {
  if (!input.resolved || input.managesExisting) {
    return {
      title: input.t('agentChat.repoPicker.platformBitbucket'),
      deniedDescription: input.t('integrations.managedByOwner'),
    };
  }
  if (input.integrationId === null) {
    return {
      title: input.t('common.connectBitbucket'),
      deniedDescription: input.t('codeReviewer.bitbucket.notConnectedReadOnly'),
    };
  }
  return {
    title: input.t('prReview.connect.reconnectTitleBitbucket'),
    deniedDescription: input.t('prReview.connect.gitlabReconnectAdminOnlyDescription'),
  };
}

/**
 * The iOS heading. The formSheet carries a grabber and the platform's dismissal
 * gesture, so the plain centred title above the form is enough; Android draws
 * the header above instead, and this component renders nothing there.
 */
function SheetTitle({ title }: Readonly<{ title: string }>) {
  if (Platform.OS === 'android') {
    return null;
  }
  return (
    <View collapsable={false} className="bg-background px-6 pt-4">
      <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
    </View>
  );
}
