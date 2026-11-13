import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { KeyRound, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useTRPC } from '@/lib/trpc';
import { i18n } from '@/i18n';

type ProviderKey = inferRouterOutputs<MobileRouter>['byok']['list'][number];

/** The personal scope: no organization, so the caller's own keys. */
const PERSONAL_SCOPE = {};

const ADD_KEY_ROUTE = '/(app)/(tabs)/(3_profile)/provider-key-add' as Href;

const SKELETON_ROWS = [0, 1];

/**
 * The height the pending band already occupies: two 104 dp skeletons and the gap
 * between them. Every state that is not the key list keeps it, so the Add key
 * action below never moves when the skeletons are replaced by the settled state.
 */
const BODY_BAND_CLASS = 'min-h-[220px]';

/**
 * The row's second line. A key the coding plan installed says so instead of
 * reporting the switch, because the switch cannot move for it.
 */
function keyStateLabel(managed: boolean, enabled: boolean): string {
  if (managed) {
    return i18n.t('profile.providerKeys.managedByPlan');
  }
  return i18n.t(enabled ? 'profile.providerKeys.enabled' : 'profile.providerKeys.disabled');
}

function ProviderKeyRow({
  providerKey,
  testing,
  toggling,
  deleting,
  onTest,
  onToggle,
  onDelete,
}: Readonly<{
  providerKey: ProviderKey;
  testing: boolean;
  toggling: boolean;
  deleting: boolean;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}>) {
  const { t } = useTranslation();
  // A key the coding plan manages cannot be changed here: the plan created it and
  // only ending the plan removes it, so every control is closed and the row says
  // why instead of failing a server call the reader could not predict.
  const managed = providerKey.management_source === 'coding_plan';
  const busy = testing || toggling || deleting;

  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {providerKey.provider_name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {keyStateLabel(managed, providerKey.is_enabled)}
          </Text>
        </View>
        <Switch
          value={providerKey.is_enabled}
          disabled={managed || busy}
          onValueChange={onToggle}
          accessibilityLabel={t('profile.providerKeys.enableKey', {
            provider: providerKey.provider_name,
          })}
        />
      </View>
      <View className="flex-row items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={managed || busy}
          loading={testing}
          onPress={onTest}
        >
          <Text>{t('profile.providerKeys.test')}</Text>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={managed || busy}
          loading={deleting}
          onPress={onDelete}
        >
          <Text>{t('common.remove')}</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * The caller's own provider keys: what each one is, whether it is in use, whether
 * it still authenticates, and the way to remove it.
 *
 * A key's value is never sent back to the app after it is saved, so no row has an
 * input for it: the only way to change one is to remove it and add another.
 * Enabling and disabling is optimistic — it is one boolean the server echoes, so
 * the switch answers the tap at once and rolls back if the write fails.
 */
export function ProviderKeysScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const listKey = trpc.byok.list.queryKey(PERSONAL_SCOPE);

  const keys = useQuery(trpc.byok.list.queryOptions(PERSONAL_SCOPE));
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: listKey });
  };

  const setEnabled = useMutation(
    trpc.byok.setEnabled.mutationOptions({
      onMutate: async input => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueryData<ProviderKey[]>(listKey);
        queryClient.setQueryData<ProviderKey[]>(listKey, rows =>
          rows?.map(row => (row.id === input.id ? { ...row, is_enabled: input.is_enabled } : row))
        );
        return { previous };
      },
      onError: (error, _input, context) => {
        if (context?.previous) {
          queryClient.setQueryData(listKey, context.previous);
        }
        toast.error(error.message);
      },
      onSettled: invalidate,
    })
  );

  const test = useMutation(
    trpc.byok.testApiKey.mutationOptions({
      // The server reports one of a fixed set of verdicts on the stored key. The
      // app says which in its own words; the provider's own text stays on the
      // server, because it can quote the upstream account and is untranslated.
      onSuccess: result => {
        switch (result.outcome) {
          case 'ok': {
            announcingToast.success(
              t('profile.providerKeys.testSucceeded', {
                provider: result.provider,
                model: result.model,
              })
            );
            break;
          }
          case 'incomplete': {
            announcingToast.error(t('profile.providerKeys.testIncomplete'));
            break;
          }
          case 'rejected': {
            announcingToast.error(t('profile.providerKeys.testRejected'));
            break;
          }
          case 'unsupported-provider': {
            announcingToast.error(t('profile.providerKeys.testUnsupportedProvider'));
            break;
          }
          case 'unreadable-key': {
            announcingToast.error(t('profile.providerKeys.testUnreadableKey'));
            break;
          }
          case 'deprecated-provider': {
            announcingToast.error(t('profile.providerKeys.testDeprecatedProvider'));
            break;
          }
          case 'failed': {
            announcingToast.error(t('profile.providerKeys.testFailed'));
            break;
          }
          default: {
            // Unreachable: `outcome` is the exhaustive discriminated union.
            const unhandled: never = result;
            throw new Error(`Unhandled key test outcome: ${String(unhandled)}`);
          }
        }
      },
      onError: () => announcingToast.error(t('profile.providerKeys.testFailed')),
      onSettled: (_result, _error, input) => {
        setTestingId(current => (current === input.id ? null : current));
      },
    })
  );

  const remove = useMutation(
    trpc.byok.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        announcingToast.success(t('profile.providerKeys.removed'));
      },
      onError: error => toast.error(error.message),
      onSettled: (_result, _error, input) => {
        setDeletingId(current => (current === input.id ? null : current));
      },
    })
  );

  const confirmRemove = (providerKey: ProviderKey) => {
    confirm({
      title: t('profile.providerKeys.removeTitle', { provider: providerKey.provider_name }),
      message: t('profile.providerKeys.removeMessage'),
      confirmLabel: t('common.remove'),
      onConfirm: () => {
        setDeletingId(providerKey.id);
        remove.mutate({ id: providerKey.id });
      },
    });
  };

  let body: ReactNode = null;
  if (keys.isPending) {
    body = (
      <View className="gap-3">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[104px] rounded-lg" />
        ))}
      </View>
    );
  } else if (keys.isError) {
    body = <QueryError onRetry={() => void keys.refetch()} isRetrying={keys.isFetching} />;
  } else if (keys.data.length === 0) {
    body = (
      <EmptyState
        placement="top"
        icon={KeyRound}
        title={t('profile.providerKeys.emptyTitle')}
        description={t('profile.providerKeys.emptyDescription')}
      />
    );
  } else {
    body = (
      <View className="gap-3">
        {keys.data.map(providerKey => (
          <ProviderKeyRow
            key={providerKey.id}
            providerKey={providerKey}
            testing={testingId === providerKey.id}
            toggling={setEnabled.isPending && setEnabled.variables.id === providerKey.id}
            deleting={deletingId === providerKey.id}
            onTest={() => {
              setTestingId(providerKey.id);
              test.mutate({ id: providerKey.id });
            }}
            onToggle={enabled => {
              setEnabled.mutate({ id: providerKey.id, is_enabled: enabled });
            }}
            onDelete={() => {
              confirmRemove(providerKey);
            }}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.providerKeys.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted" className="text-xs">
          {t('profile.providerKeys.description')}
        </Text>
        <View className={BODY_BAND_CLASS}>{body}</View>
        <View className="pt-3">
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            onPress={() => {
              router.push(ADD_KEY_ROUTE);
            }}
          >
            <Plus size={16} />
            <Text>{t('profile.providerKeys.add')}</Text>
          </Button>
        </View>
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
