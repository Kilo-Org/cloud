import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Ban } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useTRPC } from '@/lib/trpc';

const SKELETON_ROWS = [0, 1];

/** One GitHub login the reader has hidden, with the action that reveals it again. */
function HiddenLoginRow({
  login,
  actionLabel,
  actionA11y,
  busy,
  onAction,
}: Readonly<{
  login: string;
  actionLabel: string;
  actionA11y: string;
  busy: boolean;
  onAction: () => void;
}>) {
  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {login}
      </Text>
      <Button
        variant="outline"
        size="sm"
        className={STATE_ACTION_CLASS}
        disabled={busy}
        loading={busy}
        accessibilityLabel={actionA11y}
        onPress={onAction}
      >
        <Text>{actionLabel}</Text>
      </Button>
    </View>
  );
}

function HiddenLoginsSection({
  title,
  logins,
  actionLabel,
  actionA11y,
  busyLogin,
  onAction,
}: Readonly<{
  title: string;
  logins: readonly string[];
  actionLabel: string;
  actionA11y: (login: string) => string;
  busyLogin: string | null;
  onAction: (login: string) => void;
}>) {
  if (logins.length === 0) {
    return null;
  }
  return (
    <View className="gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {title}
      </Text>
      <View className="gap-3">
        {logins.map(login => (
          <HiddenLoginRow
            key={login}
            login={login}
            actionLabel={actionLabel}
            actionA11y={actionA11y(login)}
            busy={busyLogin === login}
            onAction={() => {
              onAction(login);
            }}
          />
        ))}
      </View>
    </View>
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
  const [busyLogin, setBusyLogin] = useState<string | null>(null);
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
      onSettled: () => {
        setBusyLogin(null);
      },
    })
  );

  const unmute = useMutation(
    trpc.moderation.unmuteUser.mutationOptions({
      onSuccess: (_result, input) => {
        refresh();
        announcingToast.success(t('profile.blockedPeople.unmuted', { login: input.githubLogin }));
      },
      onError: error => toast.error(error.message),
      onSettled: () => {
        setBusyLogin(null);
      },
    })
  );

  let body: ReactNode = null;
  if (hidden.isPending) {
    body = (
      <View className="gap-3">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[54px] rounded-lg" />
        ))}
      </View>
    );
  } else if (hidden.isError) {
    body = <QueryError onRetry={() => void hidden.refetch()} isRetrying={hidden.isFetching} />;
  } else if (hidden.data.blockedLogins.length === 0 && hidden.data.mutedLogins.length === 0) {
    body = (
      <EmptyState
        placement="top"
        icon={Ban}
        title={t('profile.blockedPeople.emptyTitle')}
        description={t('profile.blockedPeople.emptyDescription')}
      />
    );
  } else {
    body = (
      <View className="gap-6">
        <HiddenLoginsSection
          title={t('profile.blockedPeople.blockedSection')}
          logins={hidden.data.blockedLogins}
          actionLabel={t('profile.blockedPeople.unblock')}
          actionA11y={login => t('profile.blockedPeople.unblockA11y', { login })}
          busyLogin={busyLogin}
          onAction={login => {
            setBusyLogin(login);
            unblock.mutate({ githubLogin: login });
          }}
        />
        <HiddenLoginsSection
          title={t('profile.blockedPeople.mutedSection')}
          logins={hidden.data.mutedLogins}
          actionLabel={t('profile.blockedPeople.unmute')}
          actionA11y={login => t('profile.blockedPeople.unmuteA11y', { login })}
          busyLogin={busyLogin}
          onAction={login => {
            setBusyLogin(login);
            unmute.mutate({ githubLogin: login });
          }}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.blockedPeople.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted" className="text-xs">
          {t('profile.blockedPeople.description')}
        </Text>
        {body}
      </TabScreenScrollView>
    </View>
  );
}
