import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { PasskeyListRow } from '@/components/passkey-list-row';
import { PasskeyVerificationPanel } from '@/components/passkey-verification-panel';
import { QueryError } from '@/components/query-error';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { KeyRound, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useAuth } from '@/lib/auth/auth-context';
import { isShortViewport } from '@/lib/centered-state-layout';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { addFailureNoticeKey } from '@/lib/passkeys/add-failure-notice';
import { type PasskeyRow } from '@/lib/passkeys/passkey-types';
import { usePasskeyManagement } from '@/lib/passkeys/use-passkey-management';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';

/** Rows the skeleton reserves so loading→content does not resize the list. */
const SKELETON_ROWS = [0, 1, 2];

/**
 * A failure the user can retry in place, with the rows it sits beside left
 * rendered. The retry control is the only action: a failed request refused
 * nothing about the credential, so the same operation is a working retry.
 *
 * `pending` is the retried request's own in-flight state. It disables and
 * loads the control so a second tap cannot start a concurrent duplicate of the
 * request the first tap already sent.
 */
function InlineFailure({
  message,
  onRetry,
  pending,
}: Readonly<{ message: string; onRetry: () => void; pending: boolean }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-card p-3">
      <Text accessibilityRole="alert" className="min-w-0 flex-1 text-sm text-muted-foreground">
        {message}
      </Text>
      <Button
        variant="outline"
        size="sm"
        className={STATE_ACTION_CLASS}
        loading={pending}
        onPress={onRetry}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}

/**
 * Passkeys for the signed-in user: the list, creation through the platform
 * authenticator, rename, and removal behind a confirmation.
 *
 * A native session cannot mint, rename or remove a credential on its bearer
 * alone: the server asks for fresh primary proof, and this screen gives it in
 * the app. Every operation opens the verification panel first, which offers a
 * passkey when the account has one and a code to the account's own address
 * always; the authorization that proof mints is single-use and covers exactly
 * the operation that asked for it. A dismissed panel changed nothing, so the
 * list is left as it was. A refusal that no in-app step can fix (a sign-in that
 * cannot manage passkeys) withdraws the control and says so, and a session the
 * server has ended puts the person back on sign-in.
 *
 * Four list states: loading reserves the final rows' boxes, empty offers
 * creation as its only action, happy lists a row per passkey, and a failure is
 * either retryable in place (the list request or a removal, with whatever the
 * query last rendered kept — the rows or the empty state) or non-retryable.
 * A cancelled creation sheet changed nothing, so the list is left as it was and
 * the toast says so. A retry is single-flight — its control is disabled while
 * the request it starts is pending — and a removal failure is only actionable
 * while that delete runs or its row has rolled back, never after the server
 * list drops it.
 *
 * The Add control is the screen's one action and sits outside the scrolling
 * list, in the footer above the tab bar: the header and the control then keep
 * the same coordinates whatever the query renders (skeletons, no rows, rows),
 * so data arriving never moves the control the user is reaching for.
 */
export function PasskeysScreen() {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { token } = useAuth();
  const tabBarBottomPadding = useTabBarBottomPadding();
  const { userId, email } = useCurrentUserId();
  // The body sits between the header and a footer that already reserves the
  // tab bar, so in a phone held sideways its band is only a few dozen points
  // tall and the full stack starts below the fold. Centered states learn this
  // from their measured band; this plain body asks the window instead.
  const windowSize = useWindowDimensions();

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    ...trpc.user.getPasskeys.queryOptions(),
    enabled: token != null,
  });
  const passkeys = data?.passkeys ?? [];

  const management = usePasskeyManagement({
    accountId: userId,
    email,
    passkeys,
    onListChanged: () => void refetch(),
  });

  const [renameTarget, setRenameTarget] = useState<PasskeyRow | null>(null);

  const confirmRemove = (passkey: PasskeyRow) => {
    confirm({
      title: t('profile.removePasskeyTitle'),
      message: t('profile.removePasskeyMessage'),
      // The destructive action names itself, the same pair every other
      // confirmation in the app uses (`profile.deleteAccountTitle` /
      // `profile.deleteAccountConfirm`): a bare "Remove" would not say what
      // the row is about to lose.
      confirmLabel: t('profile.removePasskey'),
      onConfirm: () => {
        management.handleRemovePasskey(passkey.id);
      },
    });
  };

  // The control is full width in every state, in its own footer slot. Its
  // label's box takes the row's remaining width, so the one line the platform
  // lays out always has room to spare: a label sized to its own content
  // measured at its longest word's width and wrapped onto a second line the
  // button's min height then clipped (e4/p3 spot check: "Add a / passkey" in a
  // full-width button). The label's right margin mirrors the glyph and its row
  // gap, which keeps the centred label on the button's own centre.
  const addControl = management.canCreatePasskeys ? (
    <Button
      variant="outline"
      className="w-full"
      loading={management.isAdding}
      // A second operation waits for the proof already being given: the panel
      // below owns the next step while it is open.
      disabled={management.verifying}
      onPress={management.handleAddPasskey}
    >
      <Plus size={16} color={colors.foreground} />
      <Text className="mr-[24px] flex-1 text-center">{t('profile.addPasskey')}</Text>
    </Button>
  ) : null;

  // On a device that cannot create passkeys the notice is not a reaction to a
  // press: it is the reason no Add control is offered, shown beside the rows.
  const noticeKey = addFailureNoticeKey(management.canCreatePasskeys, management.addFailure);
  const addFailureNotice = noticeKey ? (
    <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
      {t(noticeKey)}
    </Text>
  ) : null;

  // The notice and the control it explains share the footer. The one exception
  // is the empty state on a device or account that cannot create passkeys: there
  // the notice replaces the hint that would name the withdrawn control, so the
  // footer must not repeat it. Every other body — the skeleton and a failed
  // first load included — keeps the notice in the footer, where it is the only
  // explanation for the control that is no longer offered.
  const emptyBodyRendered = !isPending && !(isError && data === undefined) && passkeys.length === 0;
  const footerNotice = emptyBodyRendered && !management.canCreatePasskeys ? null : addFailureNotice;

  let failureNotice: ReactNode = null;
  if (management.removeFailureId !== null) {
    failureNotice = (
      <InlineFailure
        message={t('profile.passkeyRemoveFailed')}
        // The retry names one passkey's delete, so it is locked by that delete
        // alone: another removal in flight must not load this control. A delete
        // needs fresh proof again, so the retry asks for it rather than
        // re-sending a refused call.
        pending={management.removalInFlight}
        onRetry={management.handleRetryRemove}
      />
    );
  } else if (isError && data !== undefined) {
    // A background refresh failed. Whatever was already on screen stays, and
    // the retry re-runs the same request.
    failureNotice = (
      <InlineFailure
        message={t('profile.passkeysCouldNotLoad')}
        pending={isFetching}
        onRetry={() => void refetch()}
      />
    );
  }

  let body: ReactNode = null;
  if (isPending) {
    // Loading is checked ahead of error and empty: the first frame of a cold
    // open must be the skeleton, never the empty state.
    body = (
      <View className="gap-3">
        {SKELETON_ROWS.map(index => (
          <View key={index} className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
            {/* Reserves the loaded row's 30 dp IconTile frame. */}
            <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg" />
            <View className="flex-1 gap-1.5">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-40" />
            </View>
            {/* Reserve the row controls' final 44x44pt boxes (the glyphs stay
                16pt) so a loaded row is the same height as its skeleton. */}
            <View className="min-h-[44px] min-w-[44px] items-center justify-center">
              <Skeleton className="h-4 w-4 rounded" />
            </View>
            <View className="min-h-[44px] min-w-[44px] items-center justify-center">
              <Skeleton className="h-4 w-4 rounded" />
            </View>
          </View>
        ))}
      </View>
    );
  } else if (isError && data === undefined) {
    body = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profile.passkeysCouldNotLoad')}
        message={t('profile.passkeysLoadFailed')}
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );
  } else if (passkeys.length === 0) {
    // With no passkey to list and no way to create one, the notice takes the
    // hint's place: "Add a passkey…" would instruct the control this device has
    // just withdrawn, and the notice is then the state's only content.
    //
    // A failed background refresh is reported above the empty state, not
    // hidden by it: the cached list is empty, so the notice is the only thing
    // that says the request failed and offers the retry.
    //
    // The state carries no action of its own: the Add control it describes
    // lives in the footer, where it holds the same coordinates whether the
    // query renders this state or a list of rows.
    body = (
      <>
        {failureNotice}
        {!management.verifying && (
          <EmptyState
            placement="top"
            compact={isShortViewport(windowSize.width, windowSize.height)}
            icon={KeyRound}
            title={t('profile.passkeysEmpty')}
            description={
              management.canCreatePasskeys ? t('profile.passkeysEmptyHint') : addFailureNotice
            }
          />
        )}
      </>
    );
  } else {
    body = (
      <>
        {failureNotice}
        <View className="gap-3">
          {passkeys.map(passkey => (
            <PasskeyListRow
              key={passkey.id}
              passkey={passkey}
              disabled={management.removing || management.verifying}
              onRename={setRenameTarget}
              onRemove={confirmRemove}
            />
          ))}
        </View>
      </>
    );
  }

  return (
    <View testID="passkeys-screen" className="flex-1 bg-background">
      <ScreenHeader title={t('profile.passkeysTitle')} backFallback={PROFILE_TAB_HREF} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-4 pt-4"
        showsVerticalScrollIndicator={false}
        // The panel's code field lives in this scroller, so the native inset is
        // what keeps the field and the controls under it above the keyboard.
        automaticallyAdjustKeyboardInsets
      >
        {management.verification.state.phase !== 'closed' && (
          <PasskeyVerificationPanel
            state={management.verification.state}
            onChoosePasskey={management.verification.handleChoosePasskey}
            onChooseEmail={management.verification.handleChooseEmail}
            onChooseSso={management.verification.handleChooseSso}
            onReopenApproval={management.verification.handleReopenApproval}
            onSubmitCode={management.verification.handleSubmitCode}
            onResendCode={management.verification.handleResendCode}
            onCancel={management.verification.handleCancel}
          />
        )}
        {body}
      </ScrollView>

      {/* The Add control's slot: outside the scrolling body and above the tab
          bar, it holds the coordinates the empty state first shows it at while
          the query renders skeletons, no rows, or rows. The notice that
          explains a failed or unavailable add shares the slot, beside the
          control it is about. */}
      <View className="gap-2 px-4 pt-3" style={{ paddingBottom: tabBarBottomPadding }}>
        {footerNotice}
        {addControl}
      </View>

      {renameTarget && (
        <RenameModal
          title={t('profile.renamePasskey')}
          placeholder={t('profile.passkeyName')}
          initialValue={renameTarget.name ?? ''}
          maxLength={64}
          onSave={name => {
            management.handleRenamePasskey(renameTarget, name);
            // The write happens after the proof, so the modal closes now: a
            // dismissed panel therefore writes nothing.
            return Promise.resolve();
          }}
          onClose={() => {
            setRenameTarget(null);
          }}
        />
      )}

      {dialog}
    </View>
  );
}
