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

type ProviderKey = inferRouterOutputs<MobileRouter>['byok']['list'][number];

/** The personal scope: no organization, so the caller's own keys. */
const PERSONAL_SCOPE = {};

const ADD_KEY_ROUTE = '/(app)/(tabs)/(3_profile)/provider-key-add' as Href;

const SKELETON_ROWS = [0, 1];

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
            {managed
              ? t('profile.providerKeys.managedByPlan')
              : providerKey.is_enabled
                ? t('profile.providerKeys.enabled')
                : t('profile.providerKeys.disabled')}
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
      onSuccess: result => {
        if (result.success) {
          announcingToast.success(result.message);
          return;
        }
        announcingToast.error(result.message);
      },
      onError: error => toast.error(error.message),
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
            toggling={setEnabled.isPending && setEnabled.variables?.id === providerKey.id}
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
        {body}
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
