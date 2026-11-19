import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Ban, BellOff, type LucideIcon } from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { isRetryableTrpcError, trpcErrorVariant, type TrpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

const SKELETON_ROWS = [0, 1];

/** One GitHub login the reader has hidden, with the action that reveals it again. */
function HiddenLoginRow({
  icon,
  login,
  actionLabel,
  actionA11y,
  pending,
  disabled,
  onAction,
}: Readonly<{
  icon: LucideIcon;
  login: string;
  actionLabel: string;
  actionA11y: string;
  /** This row's own request is the one in flight. */
  pending: boolean;
  /** The section's request is in flight, whichever row started it. */
  disabled: boolean;
  onAction: () => void;
}>) {
  return (
    <ConfigureRow
      icon={icon}
      title={login}
      trailing={
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={disabled}
          loading={pending}
          accessibilityLabel={actionA11y}
          onPress={onAction}
        >
          <Text>{actionLabel}</Text>
        </Button>
      }
    />
  );
}

function HiddenLoginsSection({
  title,
  icon,
  logins,
  actionLabel,
  actionA11y,
  pendingLogin,
  disabled,
  onAction,
}: Readonly<{
  title: string;
  icon: LucideIcon;
  logins: readonly string[];
  actionLabel: string;
  actionA11y: (login: string) => string;
  pendingLogin: string | null;
  disabled: boolean;
  onAction: (login: string) => void;
}>) {
  if (logins.length === 0) {
    return null;
  }
  return (
    <Section label={title}>
      <RowGroup leadingTile>
        {logins.map(login => (
          <HiddenLoginRow
            key={login}
            icon={icon}
            login={login}
            actionLabel={actionLabel}
            actionA11y={actionA11y(login)}
            pending={pendingLogin === login}
            disabled={disabled}
            onAction={() => {
              onAction(login);
            }}
          />
        ))}
      </RowGroup>
    </Section>
  );
}

/**
 * The GitHub accounts the reader has blocked or muted in pull request
 * discussions, and the way to stop hiding each one.
 *
 * Both lists are one read, so the screen has the same four states whatever it
 * holds. Unblocking and unmuting are direct actions rather than confirmations:
 * each one only reveals content the reader hid themselves, and shows the same
 * control again if they change their mind.
 */
export function BlockedPeopleScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.moderation.listHiddenUsers.queryKey();
  const hidden = useQuery(trpc.moderation.listHiddenUsers.queryOptions());
  // Reactive: a connectivity commit re-picks the failure notice's variant.
  const committedConnectivity = useCommittedConnectivityStatus();

  const refresh = () => void queryClient.invalidateQueries({ queryKey: listKey });

  const unblock = useMutation(
    trpc.moderation.unblockUser.mutationOptions({
      onSuccess: (_result, input) => {
        refresh();
        announcingToast.success(t('profile.blockedPeople.unblocked', { login: input.githubLogin }));
      },
      onError: error => toast.error(error.message),
    })
  );

  const unmute = useMutation(
    trpc.moderation.unmuteUser.mutationOptions({
      onSuccess: (_result, input) => {
        refresh();
        announcingToast.success(t('profile.blockedPeople.unmuted', { login: input.githubLogin }));
      },
      onError: error => toast.error(error.message),
    })
  );

  const hasHiddenPeople =
    hidden.data != null &&
    (hidden.data.blockedLogins.length > 0 || hidden.data.mutedLogins.length > 0);
  // A re-read the reader started that settled badly while rows are shown must
  // not silently confirm them as current. The old branch replaced the rows
  // with the error state on any failure; the profiles-list pattern keeps the
  // rows and paints the notice above them instead (finding). A confirmed
  // offline connectivity names the pause or the failure offline, like the
  // profiles list does; any other failure reports its tRPC code, and a pause
  // while connectivity is still unsettled keeps the generic copy. The notice
  // is not gated on `!isFetching`, so it stays mounted while its own Retry
  // runs and `isRetrying` reports that read.
  const stale = hidden.data != null && (hidden.isError || hidden.fetchStatus === 'paused');
  let staleVariant: 'offline' | 'neutral' | TrpcErrorVariant = 'neutral';
  if (committedConnectivity === 'offline') {
    staleVariant = 'offline';
  } else if (hidden.isError) {
    staleVariant = trpcErrorVariant(hidden.error);
  }
  const staleNotice = stale ? (
    <QueryError
      variant={staleVariant}
      placement="top"
      className="pt-0"
      onRetry={
        hidden.isError && !isRetryableTrpcError(hidden.error)
          ? undefined
          : () => void hidden.refetch()
      }
      isRetrying={hidden.isFetching}
    />
  ) : null;

  const coldPauseWithoutCache =
    hidden.fetchStatus === 'paused' &&
    hidden.data == null &&
    hidden.isPending &&
    committedConnectivity === 'offline';
  const isEmpty = hidden.data != null && !hasHiddenPeople;
  // An empty or failed list is the whole surface: its own state says everything
  // the intro would, so the intro is hidden there instead of repeating it. A
  // cached empty list whose refresh is paused or failed is the exception: the
  // stale notice has to sit above it, in the body.
  const wholeSurface = isEmpty
    ? !stale
    : hidden.data == null && (hidden.isError || coldPauseWithoutCache);
  let body: ReactNode = null;
  if (coldPauseWithoutCache) {
    // An offline cold start pauses the first read with no cache: pending
    // never settles, so the skeleton would sit forever. A pause while the
    // probe is unsettled keeps the skeleton, the same way the reviewer
    // screens classify.
    body = (
      <QueryError
        variant="offline"
        title={t('queryError.offlineTitle')}
        onRetry={() => void hidden.refetch()}
        isRetrying={hidden.isFetching}
      />
    );
  } else if (hidden.isPending) {
    body = (
      <RowGroup>
        {SKELETON_ROWS.map(row => (
          // Every hidden-login row ends in an Unblock/Mute action, which the
          // skeleton holds so neither list changes height when it loads.
          <RowSkeleton key={row} tile trailingControl />
        ))}
      </RowGroup>
    );
  } else if (hidden.isError && hidden.data == null) {
    body = <QueryError onRetry={() => void hidden.refetch()} isRetrying={hidden.isFetching} />;
  } else if (!hasHiddenPeople) {
    body = (
      <EmptyState
        icon={Ban}
        title={t('profile.blockedPeople.emptyTitle')}
        description={t('profile.blockedPeople.emptyDescription')}
        placement={wholeSurface ? 'center' : 'top'}
        refreshControl={
          <RefreshControl
            refreshing={hidden.isRefetching}
            onRefresh={() => void hidden.refetch()}
          />
        }
      />
    );
  } else {
    body = (
      <>
        <HiddenLoginsSection
          title={t('profile.blockedPeople.blockedSection')}
          icon={Ban}
          logins={hidden.data.blockedLogins}
          actionLabel={t('profile.blockedPeople.unblock')}
          actionA11y={login => t('profile.blockedPeople.unblockA11y', { login })}
          pendingLogin={unblock.isPending ? unblock.variables.githubLogin : null}
          disabled={unblock.isPending}
          onAction={login => {
            unblock.mutate({ githubLogin: login });
          }}
        />
        <HiddenLoginsSection
          title={t('profile.blockedPeople.mutedSection')}
          icon={BellOff}
          logins={hidden.data.mutedLogins}
          actionLabel={t('profile.blockedPeople.unmute')}
          actionA11y={login => t('profile.blockedPeople.unmuteA11y', { login })}
          pendingLogin={unmute.isPending ? unmute.variables.githubLogin : null}
          disabled={unmute.isPending}
          onAction={login => {
            unmute.mutate({ githubLogin: login });
          }}
        />
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.blockedPeople.title')} backFallback={PROFILE_TAB_HREF} />
      {wholeSurface ? (
        body
      ) : (
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={hidden.isRefetching}
              onRefresh={() => void hidden.refetch()}
            />
          }
        >
          <Text variant="muted">{t('profile.blockedPeople.description')}</Text>
          {staleNotice}
          {body}
        </TabScreenScrollView>
      )}
    </View>
  );
}
