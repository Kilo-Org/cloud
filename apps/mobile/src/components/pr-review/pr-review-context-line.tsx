import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useContextPicker } from '@/components/context-control';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';

/**
 * The active account/organization a PR-review surface operates under, as one
 * muted line above the surface's body copy. The name comes from the shared
 * memberships list (`common.personal` for the personal scope), so the gate and
 * the inbox never name an account the reader did not select.
 *
 * When the memberships offer somewhere else to go, the whole line is the
 * switcher: tapping it opens the same account picker sheet the Profile credits
 * card uses (`useContextPicker`), and a switch re-runs every context-scoped
 * query through `useOrganization()`. With nowhere to switch the line renders as
 * plain text — a chevron on a dead control would read as a broken affordance.
 *
 * `instanceHint` optionally names a second line: a GitLab MR deep-linked from a
 * self-managed instance carries the pasted URL's origin, and connecting on
 * gitlab.com while the MR lives on `gitlab.example.com` is the confusing case
 * the line exists to prevent. The hint is display only — the server re-derives
 * the authoritative instance.
 */
export function PrReviewContextLine({ instanceHint }: Readonly<{ instanceHint?: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { organizationId } = useOrganization();
  const organizations = useOrganizationsList();
  const orgs = organizations.data;
  const { openPicker, picker } = useContextPicker(orgs);

  const selected = orgs?.find(entry => entry.organizationId === organizationId);
  // While the list resolves the line falls back to the generic noun, matching
  // `ContextControl`'s label; the picker stays closed until the list lands.
  const name =
    organizationId === null
      ? t('common.personal')
      : (selected?.organizationName ?? t('common.organization'));

  // One option means the picker could only echo the current selection back:
  // personal with no memberships, or exactly one membership already selected.
  const options = (orgs?.length ?? 0) + 1;
  const switchable = orgs !== undefined && options > 1;

  // The memberships query can fail on first load: without handling, the line
  // would show the generic noun forever with no way to retry or pick. Mirror
  // `ContextControl`'s load-failure surface (a retry under the label) on both
  // scopes — a personal reader whose list fetch failed still loses the picker
  // — plus its missing-membership message for a stale organization selection.
  const nameError = organizations.isError;
  const unavailable =
    !organizations.isError && orgs !== undefined && organizationId !== null && !selected;
  let statusMessage: string | null = null;
  if (nameError) {
    statusMessage = t('organization.boundary.loadErrorTitle');
  } else if (unavailable) {
    statusMessage = t('organization.boundary.organizationUnavailable');
  }

  const line = (
    <Text
      className="text-center text-sm leading-[normal] text-muted-foreground"
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {t('prReview.connect.contextLine', { organization: name })}
    </Text>
  );

  return (
    <View className="min-w-0 max-w-full items-center self-center">
      {switchable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={name}
          accessibilityHint={t('profile.selectAccount')}
          onPress={openPicker}
          className="min-h-11 max-w-full flex-row items-center gap-1 px-2 active:opacity-70"
        >
          {line}
          <View className="size-5 shrink-0 items-center justify-center">
            <ChevronDown size={14} color={colors.mutedForeground} />
          </View>
        </Pressable>
      ) : (
        <View className="min-h-11 max-w-full justify-center px-2">{line}</View>
      )}
      {statusMessage ? (
        <AccessibleStatus message={statusMessage} className="text-center text-xs" tone="error" />
      ) : null}
      {nameError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          onPress={() => {
            void organizations.refetch();
          }}
          className="min-h-11 items-center justify-center px-2 active:opacity-70"
        >
          <Text className="text-sm text-muted-foreground">{t('common.retry')}</Text>
        </Pressable>
      ) : null}
      {instanceHint ? (
        <Text
          className="text-center text-xs leading-[normal] text-muted-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {instanceHint}
        </Text>
      ) : null}
      {picker}
    </View>
  );
}
