import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { PasskeyListRow } from '@/components/passkey-list-row';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { KeyRound } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useAuth } from '@/lib/auth/auth-context';
import { isShortViewport } from '@/lib/centered-state-layout';
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
 * Passkeys for the signed-in user: the list, and where to manage them.
 *
 * This screen is read-only. The server answers passkey registration and
 * management to a browser session only, so the app lists the account's
 * passkeys and the notice above the list says they are added, renamed and
 * removed in a web browser.
 *
 * Four states: loading reserves the final rows' boxes, empty explains that no
 * passkey is registered yet, happy lists a row per passkey, and a failure is
 * either retryable in place (the list request, with whatever the query last
 * rendered kept — the rows or the empty state) or the failed first load, which
 * offers the retry as its own state. A retry is single-flight — its control is
 * disabled while the request it starts is pending.
 *
 * The notice is static copy, not a reaction to a failed attempt: it renders in
 * every state, so the list cannot shift when the query settles.
 */
export function PasskeysScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const { token } = useAuth();
  // The body sits below the header inside a scrolling surface, so in a phone
  // held sideways its band is only a few dozen points tall and the full stack
  // starts below the fold. Centered states learn this from their measured band;
  // this plain body asks the window instead.
  const windowSize = useWindowDimensions();

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    ...trpc.user.getPasskeys.queryOptions(),
    enabled: token != null,
  });
  const passkeys = data?.passkeys ?? [];

  let failureNotice: ReactNode = null;
  if (isError && data !== undefined) {
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
    // No passkey to list. The notice above the body already says where
    // passkeys are managed, so this state carries neither a description that
    // would repeat it nor an action this app cannot perform.
    //
    // A failed background refresh is reported above the empty state, not
    // hidden by it: the cached list is empty, so the notice is the only thing
    // that says the request failed and offers the retry.
    body = (
      <EmptyState
        placement="top"
        compact={isShortViewport(windowSize.width, windowSize.height)}
        icon={KeyRound}
        title={t('profile.passkeysEmpty')}
      />
    );
  } else {
    body = (
      <View className="gap-3">
        {passkeys.map(passkey => (
          <PasskeyListRow key={passkey.id} passkey={passkey} />
        ))}
      </View>
    );
  }

  return (
    <View testID="passkeys-screen" className="flex-1 bg-background">
      <ScreenHeader title={t('profile.passkeysTitle')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-sm text-muted-foreground">
          {t('profile.passkeysManageInBrowser')}
        </Text>
        {failureNotice}
        {body}
      </TabScreenScrollView>
    </View>
  );
}
