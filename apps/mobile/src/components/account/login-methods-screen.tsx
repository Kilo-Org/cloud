import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { providerLabel } from '@/components/account/provider-label';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { useConfirmDialog } from '@/components/ui/dialog';
import { KeyRound, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useTRPC } from '@/lib/trpc';

/** The web page that starts a link: the round trip needs the browser's session. */
const CONNECTED_ACCOUNTS_URL = `${WEB_BASE_URL}/connected-accounts`;

/** The unlink procedure's provider argument, so a row cannot name an unchecked id. */
type AuthProviderId = inferRouterInputs<MobileRouter>['user']['unlinkAuthProvider']['provider'];

const SKELETON_ROWS = [0, 1, 2];

function ProviderRow({
  provider,
  email,
  onUnlink,
  disabled,
}: Readonly<{
  provider: string;
  email: string;
  onUnlink: () => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  const label = providerLabel(provider);

  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {email}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        className={STATE_ACTION_CLASS}
        disabled={disabled}
        accessibilityLabel={t('profile.signInMethods.unlinkProvider', { provider: label })}
        onPress={onUnlink}
      >
        <Text>{t('profile.signInMethods.unlink')}</Text>
      </Button>
    </View>
  );
}

/**
 * The sign-in methods of the account, and the way to add another.
 *
 * Unlinking asks first and the server owns the rule that at least one method
 * stays: its refusal is rendered in place, beside the list, rather than as a
 * toast, because it is the answer to the tap the reader just made and the list
 * they can act on is still above it. That inline status is the screen's single
 * announcement owner, so no toast repeats it.
 *
 * Adding a method is the web's round trip (the OAuth callback needs the browser
 * session that starts it), so the row opens the connected-accounts page in the
 * in-app browser; the list refreshes when the reader comes back.
 */
export function LoginMethodsScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  useRouteForegroundRefresh([[['user']]]);

  const providers = useQuery(trpc.user.getAuthProviders.queryOptions());
  const unlink = useMutation(
    trpc.user.unlinkAuthProvider.mutationOptions({
      onSuccess: (_result, input) => {
        setUnlinkError(null);
        void queryClient.invalidateQueries({ queryKey: trpc.user.getAuthProviders.queryKey() });
        announcingToast.success(
          t('profile.signInMethods.unlinked', { provider: providerLabel(input.provider) })
        );
      },
      // The server's message is the account of why it refused (the last method),
      // so it is shown as written.
      onError: error => setUnlinkError(error.message),
    })
  );

  const confirmUnlink = (provider: AuthProviderId) => {
    const label = providerLabel(provider);
    confirm({
      title: t('profile.signInMethods.unlinkTitle', { provider: label }),
      message: t('profile.signInMethods.unlinkMessage', { provider: label }),
      confirmLabel: t('profile.signInMethods.unlink'),
      onConfirm: () => unlink.mutate({ provider }),
    });
  };

  let body;
  if (providers.isPending) {
    body = (
      <View className="gap-3">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[62px] rounded-lg" />
        ))}
      </View>
    );
  } else if (providers.isError) {
    body = (
      <QueryError onRetry={() => void providers.refetch()} isRetrying={providers.isFetching} />
    );
  } else if (providers.data.providers.length === 0) {
    body = (
      <EmptyState
        icon={KeyRound}
        title={t('profile.signInMethods.emptyTitle')}
        description={t('profile.signInMethods.emptyDescription')}
      />
    );
  } else {
    body = (
      <View className="gap-3">
        {providers.data.providers.map(provider => (
          <ProviderRow
            key={provider.provider}
            provider={provider.provider}
            email={provider.email}
            disabled={unlink.isPending}
            onUnlink={() => confirmUnlink(provider.provider)}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.signInMethods.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {body}
        <AccessibleStatus message={unlinkError} className="text-sm" />
        <ConfigureRow
          icon={Plus}
          title={t('profile.signInMethods.linkAnother')}
          subtitle={t('profile.signInMethods.linkAnotherSubtitle')}
          className="mt-3 rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            void openExternalUrl(CONNECTED_ACCOUNTS_URL, {
              label: t('profile.signInMethods.title'),
              retryOnError: true,
            });
          }}
        />
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
