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
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
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

  const isEmpty =
    hidden.data !== undefined &&
    hidden.data.blockedLogins.length === 0 &&
    hidden.data.mutedLogins.length === 0;
  // An empty or failed list is the whole surface: its own state says everything
  // the intro would, so the intro is hidden there instead of repeating it.
  const wholeSurface = hidden.isError || isEmpty;

  let body: ReactNode = null;
  if (hidden.isPending) {
    body = (
      <RowGroup>
        {SKELETON_ROWS.map(row => (
          // Every hidden-login row ends in an Unblock/Mute action, which the
          // skeleton holds so neither list changes height when it loads.
          <RowSkeleton key={row} tile trailingControl />
        ))}
      </RowGroup>
    );
  } else if (hidden.isError) {
    body = <QueryError onRetry={() => void hidden.refetch()} isRetrying={hidden.isFetching} />;
  } else if (isEmpty) {
    body = (
      <EmptyState
        icon={Ban}
        title={t('profile.blockedPeople.emptyTitle')}
        description={t('profile.blockedPeople.emptyDescription')}
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
        >
          <Text variant="muted">
            {t('profile.blockedPeople.description')}
          </Text>
          {body}
        </TabScreenScrollView>
      )}
    </View>
  );
}
