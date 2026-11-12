import { useQuery } from '@tanstack/react-query';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ChevronDown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { contextPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

export type ContextDisplayScope = { organizationId: string | null; isResolved: boolean };

/**
 * The caller supplies its cached memberships; the picker does not fetch data.
 * Returns the opener for its control: the picker is the shared
 * `/context-picker` formSheet route, so every surface presents the same sheet
 * and the navigator owns its dismissal and Android Back.
 * `onSelectionChange` fires only for a picked account that differs from the
 * shown one, so a caller that reloads its screen can leave a re-pick of the
 * current account a no-op.
 *
 * `shownOrganizationId` is the account the caller's screen is scoped to when
 * that differs from the active one (for example an explicit route scope). It
 * drives the check mark and the no-op comparison; a pick still changes the
 * active account, which is what every other surface reads.
 */
export function useContextPicker(
  orgs: OrgListEntry[] | undefined,
  onSelectionChange?: (organizationId: string | null) => void,
  shownOrganizationId?: string | null
) {
  const router = useRouter();
  const { t } = useTranslation();
  const { setOrganizationId, organizationId } = useOrganization();
  const shownId = shownOrganizationId !== undefined ? shownOrganizationId : organizationId;
  // Personal is index 0 and the memberships follow in list order. A persisted
  // membership that is no longer listed checks nothing, so the mark never names
  // an account the user is not on.
  const labels = [t('common.personal'), ...(orgs ?? []).map(org => org.organizationName)];
  const memberIndex = orgs?.findIndex(org => org.organizationId === shownId) ?? -1;
  let currentIndex = -1;
  if (shownId === null) {
    currentIndex = 0;
  } else if (memberIndex >= 0) {
    currentIndex = memberIndex + 1;
  }

  const select = (index: number) => {
    if (index === 0) {
      if (shownId !== null) {
        setOrganizationId(null);
        onSelectionChange?.(null);
      }
      return;
    }
    const org = orgs?.[index - 1];
    if (org && org.organizationId !== shownId) {
      setOrganizationId(org.organizationId);
      onSelectionChange?.(org.organizationId);
    }
  };

  return {
    openPicker: () => {
      if (!orgs) {
        return;
      }
      // The route reads its rows and its pick from the registry, so the
      // memberships and the selection identity the control shows are the ones
      // the sheet renders.
      contextPickerSlot.set(UNFENCED_ROUTE_KEY, { options: labels, currentIndex, onSelect: select });
      router.push('/(app)/context-picker' as Href);
    },
  };
}

/**
 * The trigger a stacked form gives its pickers: the same bordered full-width
 * box `InstanceSelector` and `RepoSelector` render, so one label-value relation
 * on a form keeps one shape.
 */
const FIELD_TRIGGER_CLASS =
  'flex-row items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3';

/**
 * An explicit `scope` is always read-only; explicit null never inherits global
 * scope. `value` instead keeps the control switchable while it shows the account
 * the caller's screen is scoped to, which may differ from the active account.
 *
 * `variant` picks the shape: `inline` is the compact label-and-chevron a header
 * or a detail row shows, and `field` is the stacked form's full-width trigger.
 *
 * `failurePlacement` decides where the account-list failure goes, so a caller
 * whose own body states it can keep a fixed header one row tall:
 *
 * - `rows` (default) stacks the message and a Retry under the label, for a
 *   screen whose body has no other recovery for that query.
 * - `row` keeps the control one row tall and, while there is no usable list,
 *   makes that row the retry: the label becomes the message and a press
 *   refetches the list. A failed refetch that still has cached memberships
 *   keeps the picker row, because the picker works from them. Nothing is added
 *   below either way, so the header keeps its height in every state.
 * - `none` draws neither, for a surface that states the failure and retries it
 *   elsewhere. Two rows here made a fixed header grow by their combined height,
 *   so the whole body moved down while the list failed and back up when it
 *   recovered (the pending-to-error jump).
 *
 * The provider's own stored-choice read or write failure always renders the
 * `rows` form, whatever the placement: no other surface reaches it.
 */
export function ContextControl({
  scope,
  showOrganizationName = true,
  onSelectionChange,
  value,
  variant = 'inline',
  failurePlacement = 'rows',
}: Readonly<{
  scope?: ContextDisplayScope;
  showOrganizationName?: boolean;
  onSelectionChange?: (organizationId: string | null) => void;
  value?: string | null;
  variant?: 'inline' | 'field';
  failurePlacement?: 'rows' | 'row' | 'none';
}>) {
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
  const { openPicker } = useContextPicker(orgs, onSelectionChange, scope ? undefined : value);
  // A caller-supplied `value` (or a read-only scope) is the screen's own
  // account; otherwise the active account drives the label.
  const shownId = value !== undefined ? value : context.organizationId;
  const organizationId = scope ? scope.organizationId : shownId;
  const isResolved = scope ? scope.isResolved : context.isLoaded || value !== undefined;
  const providerError = scope || value !== undefined ? null : context.error;
  const org = orgs?.find(entry => entry.organizationId === organizationId);
  const nameError = isResolved && (!scope || organizationId !== null) && organizations.isError;
  const unavailable = isResolved && organizationId !== null && orgs !== undefined && !org;
  const pending =
    (!isResolved && providerError !== 'restore') ||
    (isResolved && organizationId !== null && orgs === undefined && !nameError);
  const organizationName = showOrganizationName ? org?.organizationName : undefined;
  let label =
    organizationId === null ? t('common.personal') : (organizationName ?? t('common.organization'));
  if (!isResolved) {
    label = t('profile.selectAccount');
  }
  let errorMessage: string | null = null;
  let retry: (() => void) | undefined = undefined;
  if (providerError) {
    // The stored choice's own read or write failed, and nothing else on the
    // screen reaches that failure: this control keeps both the message and the
    // Retry, whatever the caller asked for the list failure.
    errorMessage =
      providerError === 'restore'
        ? t('common.somethingWentWrong')
        : t('common.couldNotSaveSetting');
    retry = context.retry;
  } else if (failurePlacement !== 'none' && nameError) {
    errorMessage = t('organization.boundary.loadErrorTitle');
    retry = () => {
      void organizations.refetch();
    };
  } else if (failurePlacement !== 'none' && unavailable) {
    errorMessage = t('organization.boundary.organizationUnavailable');
  }
  // The one-row placement moves the message and the action into the control's
  // own row: no message line and no second Retry row, so the header keeps its
  // height. It applies only while there is no usable list. A failed background
  // refetch leaves cached memberships present, and the picker still works from
  // them, so that frame keeps the picker row and simply adds no failure rows.
  // The provider's own stored-choice failure keeps the default rows under every
  // placement, because no other surface reaches it.
  const rowIsRetry =
    failurePlacement === 'row' && !providerError && retry !== undefined && orgs === undefined;
  const placedMessage = providerError || failurePlacement === 'rows' ? errorMessage : null;
  const retryBusy =
    providerError === 'save' ? context.isSaving : !providerError && organizations.isFetching;
  const disabled = !isResolved || orgs === undefined;
  const pickerBusy = pending || (orgs === undefined && token != null && organizations.isPending);
  const field = variant === 'field';
  const rowLabel = rowIsRetry ? (errorMessage ?? label) : label;
  const content = pending ? (
    <Skeleton className="h-5 w-36 max-w-full shrink rounded" />
  ) : (
    <Text
      className={cn(
        'min-w-0 leading-[normal]',
        field ? 'flex-1 text-base text-foreground' : 'shrink text-sm text-muted-foreground',
        rowIsRetry && 'text-destructive'
      )}
      numberOfLines={1}
      // Memberships of one workspace share their leading words, so the tail is
      // what tells them apart: cutting it drops the account's own name. A
      // failure message reads from its start, so only that one cuts the tail.
      ellipsizeMode={rowIsRetry ? 'tail' : 'middle'}
    >
      {rowLabel}
    </Text>
  );

  // Two shapes of the same row: the retry form, for a surface whose body has no
  // recovery of its own for this query, and the picker form every other frame
  // shows. The read-only `scope` form only names the account.
  const retryRow = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rowLabel}
      accessibilityState={{ busy: retryBusy, disabled: retryBusy }}
      disabled={retryBusy}
      onPress={retry}
      className={cn(
        field ? FIELD_TRIGGER_CLASS : cn(ROW_TARGET_CLASS, 'flex-row items-center gap-1'),
        'active:opacity-70'
      )}
    >
      {content}
      <View className="size-5 shrink-0 items-center justify-center">
        {retryBusy && <ActivityIndicator size="small" color={colors.mutedForeground} />}
      </View>
    </Pressable>
  );
  const pickerRow = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('profile.selectAccount')}
      accessibilityState={{ busy: pickerBusy, disabled }}
      disabled={disabled}
      onPress={openPicker}
      className={cn(
        field ? FIELD_TRIGGER_CLASS : cn(ROW_TARGET_CLASS, 'flex-row items-center gap-1'),
        'active:opacity-70',
        field && disabled && 'opacity-50'
      )}
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
  );
  let row = pickerRow;
  if (scope) {
    row = (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={rowLabel}
        accessibilityState={{ busy: pending }}
        className={field ? FIELD_TRIGGER_CLASS : cn(ROW_TARGET_CLASS, 'justify-center')}
      >
        {content}
      </View>
    );
  } else if (rowIsRetry) {
    row = retryRow;
  }

  return (
    <View className="min-w-0 max-w-full">
      {row}
      <AccessibleStatus message={placedMessage} className="text-sm" />
      {retry && placedMessage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          accessibilityHint={placedMessage}
          accessibilityState={{ busy: retryBusy, disabled: retryBusy }}
          disabled={retryBusy}
          onPress={retry}
          className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-2 active:opacity-70')}
        >
          <Text className="text-sm text-primary">{t('common.retry')}</Text>
          {retryBusy && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        </Pressable>
      ) : null}
    </View>
  );
}
