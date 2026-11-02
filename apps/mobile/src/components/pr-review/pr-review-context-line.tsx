import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useContextPicker } from '@/components/context-control';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { cn } from '@/lib/utils';

/**
 * The active account/organization a PR-review surface operates under, as one
 * line alongside the surface's body copy — above it where the copy names the
 * account ("switch the account above"), below it in the connect gates. The name
 * comes from the shared memberships list (`common.personal` for the personal
 * scope), so the gate and the inbox never name an account the reader did not
 * select.
 *
 * When the memberships offer somewhere else to go, the whole line is the
 * switcher: tapping it opens the same account picker sheet the Profile credits
 * card uses (`useContextPicker`), and a switch re-runs every context-scoped
 * query through `useOrganization()`. It is drawn as an outlined pill so it
 * reads as a control; with nowhere to switch it renders as plain muted text — a
 * chevron on a dead control would read as a broken affordance.
 *
 * `instanceHint` optionally names a second line: a GitLab MR deep-linked from a
 * self-managed instance carries the pasted URL's origin, and connecting on
 * gitlab.com while the MR lives on `gitlab.example.com` is the confusing case
 * the line exists to prevent. The hint is display only — the server re-derives
 * the authoritative instance.
 */
export function PrReviewContextLine({
  instanceHint,
  className,
}: Readonly<{
  instanceHint?: string;
  /**
   * Spacing for the caller's stack. A caller that puts the line below body copy
   * passes a top margin so the outlined pill does not sit against the last
   * text line; the arm that puts it above its explanation needs none.
   */
  className?: string;
}>) {
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

  // The switchable line is a control, so it is drawn as one: a bordered pill in
  // the primary text color, whose surface/border pair follows `Button`'s
  // `outline` variant (the dark hairline alone is too faint on the near-black
  // card). With nowhere to switch the same line stays plain muted text.
  const line = (
    <Text
      className={cn(
        'text-center text-sm leading-[normal]',
        switchable ? 'text-foreground' : 'text-muted-foreground'
      )}
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {organizationId === null
        ? t('prReview.connect.contextLinePersonal')
        : t('prReview.connect.contextLine', { organization: name })}
    </Text>
  );

  return (
    <View className={cn('min-w-0 max-w-full items-center self-center', className)}>
      {switchable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={name}
          accessibilityHint={t('profile.selectAccount')}
          onPress={openPicker}
          className={cn(
            ROW_TARGET_CLASS,
            'max-w-full flex-row items-center gap-1 rounded-full border border-border bg-card px-3 active:opacity-70 dark:border-neutral-700 dark:bg-secondary'
          )}
        >
          {line}
          <View className="size-5 shrink-0 self-center items-center justify-center">
            <ChevronDown size={14} color={colors.foreground} />
          </View>
        </Pressable>
      ) : (
        <View className={cn(ROW_TARGET_CLASS, 'max-w-full justify-center px-2')}>{line}</View>
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
          className={cn(ROW_TARGET_CLASS, 'items-center justify-center px-2 active:opacity-70')}
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
