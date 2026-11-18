import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Plus, SlidersHorizontal } from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import { type OrgMode } from '@/components/organization/org-mode-form-model';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { OrgRecordRow } from '@/components/organization/org-record-row';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RowGroup } from '@/components/ui/row-group';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useOrgModes } from '@/lib/hooks/use-org-modes-queries';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { collator } from '@/lib/intl-cache';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

const MODE_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/mode-form' as const;

function sortModes(modes: readonly OrgMode[], language: string): readonly OrgMode[] {
  // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
  return [...modes].sort((a, b) =>
    collator(language, { sensitivity: 'base' }).compare(a.name, b.name)
  );
}

function ModesSkeleton() {
  return (
    <Card>
      <Skeleton className="h-4 w-40 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-56 rounded bg-muted-soft" />
    </Card>
  );
}

/**
 * The organization's custom modes.
 *
 * The web page lists the built-in modes with the organization's overrides beside
 * them and opens one form per mode. This screen lists the modes the organization
 * stores — a stored mode whose slug matches a built-in one replaces that built-in
 * mode — and opens that same form. The list carries no role gate because the page
 * has none: every member reads it, and the server decides whether a write lands.
 */
export function OrganizationModesScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, org, isResolving } = useOrgBoundary();
  const modesQuery = useOrgModes(organizationId);

  const openModeForm = (modeId?: string) => {
    router.push({
      pathname: MODE_FORM_PATH,
      params: modeId === undefined ? {} : { modeId },
    });
  };

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('agentChat.modePicker.customModes')} />;
  }

  const modes = modesQuery.data?.modes ?? [];
  const errorView = modesQuery.isError ? selectOrgListErrorView(modesQuery.error) : null;

  let body: ReactNode = null;
  if (modesQuery.isPending) {
    body = <ModesSkeleton />;
  } else if (errorView) {
    body = (
      <QueryError
        variant={errorView.variant}
        onRetry={errorView.showRetry ? () => void modesQuery.refetch() : undefined}
        isRetrying={modesQuery.isFetching}
      />
    );
  } else if (modes.length === 0) {
    body = (
      <EmptyState
        icon={SlidersHorizontal}
        placement="top"
        title={t('organization.modes.emptyTitle')}
        description={t('organization.modes.emptyDescription')}
        action={
          <Button
            className={STATE_ACTION_CLASS}
            onPress={() => {
              openModeForm();
            }}
          >
            <Text className="text-primary-foreground">{t('organization.modes.create')}</Text>
          </Button>
        }
      />
    );
  } else {
    const sorted = sortModes(modes, i18n.language);
    body = (
      <RowGroup>
        {sorted.map(mode => (
          <OrgRecordRow
            key={mode.id}
            title={mode.name}
            meta={mode.slug}
            description={mode.config.description}
            // Names can repeat; the slug is the row's unique fact, so a reader
            // hears it too instead of two identical rows.
            accessibilityLabel={[mode.name, mode.slug].join(', ')}
            onPress={() => {
              openModeForm(mode.id);
            }}
          />
        ))}
      </RowGroup>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentChat.modePicker.customModes')}
        headerRight={
          <IconButton
            accessibilityLabel={t('organization.modes.create')}
            onPress={() => {
              openModeForm();
            }}
          >
            <Plus size={22} color={colors.foreground} />
          </IconButton>
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
        // The design gate's proof readiness marker for this route.
        testID="organization-modes-list"
      >
        {body}
      </TabScreenScrollView>
    </View>
  );
}
