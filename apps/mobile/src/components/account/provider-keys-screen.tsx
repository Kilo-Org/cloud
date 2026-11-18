import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { type ProviderKey, ProviderKeyRow } from '@/components/account/provider-key-row';
import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Card } from '@/components/ui/card';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  providerKeyAddHref,
  providerKeyNewHref,
  providerKeyPermissions,
  providerKeyScope,
  providerKeyScopeInput,
} from '@/lib/byok/provider-key-scope';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

const SKELETON_ROWS = [0, 1];

/**
 * The height the pending band already occupies: two key cards and the gap
 * between them. Every state that is not the key list keeps it, so the list
 * never moves when the skeletons are replaced by the settled state.
 */
const BODY_BAND_CLASS = 'min-h-64 gap-3';

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
      <>
        {SKELETON_ROWS.map(row => (
          <Card key={row}>
            <View className="flex-row items-center gap-3">
              <Skeleton className="h-4 w-32 max-w-full" />
              <View className="flex-1" />
              <Skeleton className="h-6 w-12 rounded-full" />
            </View>
            <Skeleton className="h-8 w-full rounded-md" />
          </Card>
        ))}
      </>
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
    // The header's "+" is the screen's one create control, so the empty state
    // carries the title and its hint only.
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
      <>
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
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profile.providerKeys.title')}
        backFallback={PROFILE_TAB_HREF}
        headerRight={
          permissions.canEdit ? (
            <IconButton
              accessibilityLabel={t('profile.providerKeys.add')}
              onPress={() => {
                router.push(providerKeyAddHref(scope));
              }}
            >
              <Plus size={20} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted">
          {scope.kind === 'organization'
            ? t('profile.providerKeys.orgDescription')
            : t('profile.providerKeys.description')}
        </Text>
        {scope.kind === 'organization' && !permissions.canEdit ? (
          <Text variant="muted">{t('profile.providerKeys.viewOnly')}</Text>
        ) : null}
        <View className={BODY_BAND_CLASS}>{body}</View>
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
