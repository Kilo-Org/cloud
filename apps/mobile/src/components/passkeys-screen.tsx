import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { PasskeyListRow } from '@/components/passkey-list-row';
import { PasskeyVerificationPanel } from '@/components/passkey-verification-panel';
import { QueryError } from '@/components/query-error';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { Card } from '@/components/ui/card';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { KeyRound, Plus, RotateCcw } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS, SCREEN_GUTTER_CLASS } from '@/lib/layout';
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
    <Card className="flex-row items-center">
      <Text accessibilityRole="alert" className="min-w-0 flex-1 text-sm text-muted-foreground">
        {message}
      </Text>
      <StateAction label={t('common.retry')} icon={RotateCcw} loading={pending} onPress={onRetry} />
    </Card>
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
 * Four list states: loading reserves the final rows' boxes, empty states the
 * list, happy lists a row per passkey, and a failure is either retryable in
 * place (the list request or a removal, with whatever the query last rendered
 * kept — the rows or the empty state) or non-retryable. A cancelled creation
 * sheet changed nothing, so the list is left as it was and the toast says so.
 * A retry is single-flight — its control is disabled while the request it
 * starts is pending — and a removal failure is only actionable while that
 * delete runs or its row has rolled back, never after the server list drops it.
 *
 * The header's "+" is the screen's one create control, as on every list screen
 * with a create action; the empty state carries the title and its hint only.
 */
export function PasskeysScreen() {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { token } = useAuth();
  const { userId, email } = useCurrentUserId();

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

  // The header's "+" is the screen's one create control; the empty state keeps
  // only its title and description. On a device that cannot create passkeys the
  // notice is not a reaction to a press: it is the reason no Add control is
  // offered, so it stays in the body beside the rows it explains.
  const noticeKey = addFailureNoticeKey(management.canCreatePasskeys, management.addFailure);
  const addFailureNotice = noticeKey ? (
    <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
      {t(noticeKey)}
    </Text>
  ) : null;

  // The one exception is the empty state on a device or account that cannot
  // create passkeys: there the notice replaces the hint that would name the
  // withdrawn control, so the body must not repeat it. Every other body — the
  // skeleton and a failed first load included — keeps the notice in the body,
  // where it is the only explanation for the control that is no longer offered.
  const emptyBodyRendered = !isPending && !(isError && data === undefined) && passkeys.length === 0;
  const bodyNotice = emptyBodyRendered && !management.canCreatePasskeys ? null : addFailureNotice;

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

  // A state that is the whole surface — no intro, no list, no panel above it —
  // renders in the screen body, centred in the band between the header and the
  // footer. Under the verification panel, or above a failed-refresh notice, the
  // same state is placed at the top. The empty state's Add action is inline in
  // its slot and the footer drops its own, so the control does not move.
  const panelOpen = management.verification.state.phase !== 'closed';
  let hoistedState = false;
  if (!panelOpen && !isPending) {
    hoistedState =
      (isError && data === undefined) || (passkeys.length === 0 && failureNotice === null);
  }

  let body: ReactNode = null;
  if (isPending) {
    // Loading is checked ahead of error and empty: the first frame of a cold
    // open must be the skeleton, never the empty state.
    body = (
      <RowGroup leadingTile>
        {SKELETON_ROWS.map(index => (
          <RowSkeleton key={index} tile subtitle trailingControl />
        ))}
      </RowGroup>
    );
  } else if (isError && data === undefined) {
    body = (
      <QueryError
        variant="server"
        placement={hoistedState ? 'center' : 'top'}
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
    body = (
      <>
        {failureNotice}
        <EmptyState
          placement={hoistedState ? 'center' : 'top'}
          icon={KeyRound}
          title={t('profile.passkeysEmpty')}
          description={
            management.canCreatePasskeys ? t('profile.passkeysEmptyHint') : addFailureNotice
          }
        />
      </>
    );
  } else {
    body = (
      <>
        {failureNotice}
        <RowGroup leadingTile>
          {passkeys.map(passkey => (
            <PasskeyListRow
              key={passkey.id}
              passkey={passkey}
              disabled={management.removing || management.verifying}
              onRename={setRenameTarget}
              onRemove={confirmRemove}
            />
          ))}
        </RowGroup>
      </>
    );
  }

  return (
    <View testID="passkeys-screen" className="flex-1 bg-background">
      <ScreenHeader
        title={t('profile.passkeysTitle')}
        backFallback={PROFILE_TAB_HREF}
        headerRight={
          management.canCreatePasskeys ? (
            <IconButton
              accessibilityLabel={t('profile.addPasskey')}
              // A second operation waits for the proof already being given: the
              // panel owns the next step while it is open.
              disabled={management.isAdding || management.verifying}
              accessibilityState={{
                busy: management.isAdding,
                disabled: management.isAdding || management.verifying,
              }}
              onPress={management.handleAddPasskey}
            >
              <Plus size={20} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      {hoistedState ? (
        <>
          {bodyNotice === null ? null : <View className={SCREEN_GUTTER_CLASS}>{bodyNotice}</View>}
          {body}
        </>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
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
          {bodyNotice}
          {body}
        </ScrollView>
      )}

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
