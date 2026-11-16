import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
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
import {
  providerKeyAddHref,
  providerKeyNewHref,
  providerKeyPermissions,
  providerKeyScope,
  providerKeyScopeInput,
} from '@/lib/byok/provider-key-scope';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

type ProviderKey = inferRouterOutputs<MobileRouter>['byok']['list'][number];

const SKELETON_ROWS = [0, 1];

/**
 * The height the pending band already occupies: two 104 dp skeletons and the gap
 * between them. Every state that is not the key list keeps it, so the Add key
 * action below never moves when the skeletons are replaced by the settled state.
 */
const BODY_BAND_CLASS = 'min-h-[220px]';

function ProviderKeyRow({
  providerKey,
  testing,
  toggling,
  deleting,
  canEdit,
  onTest,
  onToggle,
  onEdit,
  onDelete,
}: Readonly<{
  providerKey: ProviderKey;
  testing: boolean;
  toggling: boolean;
  deleting: boolean;
  canEdit: boolean;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const { t } = useTranslation();
  // A key the coding plan manages cannot be changed here: the plan created it and
  // only ending the plan removes it, so every control is closed and the row says
  // why instead of failing a server call the reader could not predict.
  const managed = providerKey.management_source === 'coding_plan';
  const editable = canEdit && !managed;
  const busy = testing || toggling || deleting;

  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {providerKey.provider_name}
          </Text>
          {/*
            Only a managed row keeps a line: its switch is disabled, so it cannot
            carry the state and the row has to name the plan instead.
          */}
          {managed ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {t('profile.providerKeys.managedByPlan')}
            </Text>
          ) : null}
        </View>
        <Switch
          value={providerKey.is_enabled}
          disabled={!editable || busy}
          onValueChange={onToggle}
          accessibilityLabel={t('profile.providerKeys.enableKey', {
            provider: providerKey.provider_name,
          })}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={!editable || busy}
          loading={testing}
          onPress={onTest}
        >
          <Text>{t('profile.providerKeys.test')}</Text>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={!editable || busy}
          onPress={onEdit}
        >
          <Text>{t('profile.providerKeys.edit')}</Text>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={!editable || busy}
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
 * The keys of one scope: the caller's own, or an organization's.
 *
 * A key's value is never sent back to the app after it is saved, so no row has
 * an input for it: editing one means entering a new value to replace it, and
 * removing it is the only other way to change it. Enabling and disabling is
 * optimistic — it is one boolean the server echoes, so the switch answers the
 * tap at once and rolls back if the write fails.
 *
 * An organization's keys are readable by every member and writable by a
 * billing role, which is the rule every byok procedure applies; a personal
 * account is always its own owner.
 */
export function ProviderKeysScreen({ organizationId }: Readonly<{ organizationId?: string }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { confirm, dialog } = useConfirmDialog();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const scope = providerKeyScope(organizationId);
  // A personal scope ignores the role it resolves; only an organization's
  // membership decides what the caller may do with the keys it reads.
  const { role, org, isResolving } = useOrgBoundary(organizationId);
  const permissions = providerKeyPermissions(scope, role);
  const scopeInput = providerKeyScopeInput(scope);
  const listKey = trpc.byok.list.queryKey(scopeInput);

  const keys = useQuery(trpc.byok.list.queryOptions(scopeInput));
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
        remove.mutate({ ...scopeInput, id: providerKey.id });
      },
    });
  };

  if (scope.kind === 'organization' && (isResolving || org == null)) {
    // Not resolved, a failed organization list, or an id the viewer is not a
    // member of. The boundary owns all three, so a list that failed to load is
    // retryable instead of reading as a membership this screen cannot verify.
    return (
      <OrganizationBoundary
        title={t('profile.providerKeys.title')}
        organizationIdOverride={organizationId}
      />
    );
  }

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
    // A terminal code (a refusal the server will repeat) gets the state its
    // cause names and no retry; anything else may answer differently next time.
    const retryable = isRetryableTrpcError(keys.error);
    body = (
      <QueryError
        variant={trpcErrorVariant(keys.error)}
        {...(retryable ? { onRetry: () => void keys.refetch(), isRetrying: keys.isFetching } : {})}
      />
    );
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
            canEdit={permissions.canEdit}
            onTest={() => {
              setTestingId(providerKey.id);
              test.mutate({ ...scopeInput, id: providerKey.id });
            }}
            onToggle={enabled => {
              setEnabled.mutate({ ...scopeInput, id: providerKey.id, is_enabled: enabled });
            }}
            onEdit={() => {
              router.push(providerKeyNewHref(scope, providerKey.provider_id, providerKey.id));
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
          {scope.kind === 'organization'
            ? t('profile.providerKeys.orgDescription')
            : t('profile.providerKeys.description')}
        </Text>
        {scope.kind === 'organization' && !permissions.canEdit ? (
          <Text variant="muted" className="text-xs">
            {t('profile.providerKeys.viewOnly')}
          </Text>
        ) : null}
        <View className={BODY_BAND_CLASS}>{body}</View>
        {permissions.canEdit ? (
          <View className="pt-3">
            <Button
              variant="outline"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                router.push(providerKeyAddHref(scope));
              }}
            >
              <Plus size={16} color={colors.foreground} />
              <Text>{t('profile.providerKeys.add')}</Text>
            </Button>
          </View>
        ) : null}
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
