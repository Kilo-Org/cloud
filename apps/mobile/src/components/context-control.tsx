import { useActionSheet } from '@expo/react-native-action-sheet';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ChevronDown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

export type ContextDisplayScope = { organizationId: string | null; isResolved: boolean };

/** The caller supplies its cached memberships; the picker does not fetch data. */
export function useContextPicker(orgs: OrgListEntry[] | undefined) {
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const { setOrganizationId } = useOrganization();

  return () => {
    if (!orgs) {
      return;
    }
    const options = [
      t('profile.personal'),
      ...orgs.map(org => org.organizationName),
      t('common.cancel'),
    ];
    const cancelButtonIndex = options.length - 1;
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex,
        title: t('profile.selectAccount'),
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === undefined || index === cancelButtonIndex) {
          return;
        }
        if (index === 0) {
          setOrganizationId(null);
        } else {
          const org = orgs[index - 1];
          if (org) {
            setOrganizationId(org.organizationId);
          }
        }
      }
    );
  };
}

/** An explicit scope is always read-only; explicit null never inherits global scope. */
export function ContextControl({
  scope,
  showOrganizationName = true,
}: Readonly<{ scope?: ContextDisplayScope; showOrganizationName?: boolean }>) {
  const context = useOrganization();
  const { token } = useAuth();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const organizations = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: token != null,
  });
  const orgs = organizations.data;
  const openPicker = useContextPicker(orgs);
  const organizationId = scope ? scope.organizationId : context.organizationId;
  const isResolved = scope ? scope.isResolved : context.isLoaded;
  const providerError = scope ? null : context.error;
  const org = orgs?.find(entry => entry.organizationId === organizationId);
  const nameError = isResolved && (!scope || organizationId !== null) && organizations.isError;
  const unavailable = isResolved && organizationId !== null && orgs !== undefined && !org;
  const pending =
    (!isResolved && providerError !== 'restore') ||
    (isResolved && organizationId !== null && orgs === undefined && !nameError);
  const organizationName = showOrganizationName ? org?.organizationName : undefined;
  let label =
    organizationId === null
      ? t('profile.personal')
      : (organizationName ?? t('profile.organization'));
  if (!isResolved) {
    label = t('profile.selectAccount');
  }
  let errorMessage: string | null = null;
  let retry: (() => void) | undefined = undefined;
  if (providerError) {
    errorMessage =
      providerError === 'restore'
        ? t('common.somethingWentWrong')
        : t('common.couldNotSaveSetting');
    retry = context.retry;
  } else if (nameError) {
    errorMessage = t('organization.boundary.loadErrorTitle');
    retry = () => {
      void organizations.refetch();
    };
  } else if (unavailable) {
    errorMessage = t('organization.boundary.organizationUnavailable');
  }
  const retryBusy =
    providerError === 'save' ? context.isSaving : !providerError && organizations.isFetching;
  const disabled = !isResolved || orgs === undefined;
  const pickerBusy = pending || (orgs === undefined && token != null && organizations.isPending);
  const content = pending ? (
    <Skeleton className="h-5 w-36 max-w-full shrink rounded" />
  ) : (
    <Text
      className="min-w-0 shrink text-sm leading-[normal] text-muted-foreground"
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {label}
    </Text>
  );

  return (
    <View className="min-w-0 max-w-full">
      {scope ? (
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={label}
          accessibilityState={{ busy: pending }}
          className="min-h-11 justify-center"
        >
          {content}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={t('profile.selectAccount')}
          accessibilityState={{ busy: pickerBusy, disabled }}
          disabled={disabled}
          onPress={openPicker}
          className="min-h-11 flex-row items-center gap-1 active:opacity-70"
        >
          {content}
          <View className="size-5 shrink-0 items-center justify-center">
            {pickerBusy ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <ChevronDown size={14} color={colors.mutedForeground} />
            )}
          </View>
        </Pressable>
      )}
      <AccessibleStatus message={errorMessage} className="text-sm" />
      {retry && errorMessage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          accessibilityHint={errorMessage}
          accessibilityState={{ busy: retryBusy, disabled: retryBusy }}
          disabled={retryBusy}
          onPress={retry}
          className="min-h-11 flex-row items-center gap-2 active:opacity-70"
        >
          <Text className="text-sm text-primary">{t('common.retry')}</Text>
          {retryBusy && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        </Pressable>
      ) : null}
    </View>
  );
}
