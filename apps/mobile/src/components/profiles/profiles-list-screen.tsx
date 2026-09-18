import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import {
  buildProfileSections,
  formatProfileCounts,
  isEffectiveDefault,
  profileCounts,
} from '@/components/profiles/profile-list-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Plus, SlidersHorizontal, Star } from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type AgentProfileListItem, useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import { useOrganization } from '@/lib/organization-context';
import { getProfileOverviewPath } from '@/lib/profile-agent-navigation';

const NEW_PROFILE_PATH = '/(app)/(tabs)/(3_profile)/profiles/new' as Href;

/** Profile name plus the default marker, for the star's accessibility label. */
function defaultStarLabel(name: string, defaultLabel: string): string {
  return [name, defaultLabel].join(', ');
}

/**
 * The effective-default marker. Returns `undefined` when the profile is not
 * the default, so `ConfigureRow` falls back to its chevron.
 */
function renderDefaultStar({
  isDefault,
  name,
  label,
  color,
}: Readonly<{ isDefault: boolean; name: string; label: string; color: string }>) {
  if (!isDefault) {
    return undefined;
  }
  return (
    <Star size={16} color={color} fill={color} accessibilityLabel={defaultStarLabel(name, label)} />
  );
}

/**
 * Content-shaped loading rows. Each mirrors a loaded `ConfigureRow` (py-3 +
 * the 30pt icon tile beside the two-line text block) so the swap to real rows
 * does not move the screen.
 */
function ProfileListSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <View key={index} className="flex-row items-center gap-3 rounded-lg bg-secondary px-3 py-3">
          <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg bg-muted-soft" />
          <View className="flex-1 gap-0.5">
            <Skeleton className="h-5 w-32 rounded bg-muted-soft" />
            <Skeleton className="h-4 w-40 rounded bg-muted-soft" />
          </View>
        </View>
      ))}
    </View>
  );
}

export function ProfilesListScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, isLoaded } = useOrganization();
  const isOrgContext = organizationId != null;
  const {
    orgProfiles,
    personalProfiles,
    effectiveDefaultId,
    isLoading,
    isError,
    isRefetching,
    refetch,
  } = useAgentProfileList(organizationId ?? undefined);

  const sections = buildProfileSections({ orgProfiles, personalProfiles, isOrgContext });
  // Wait for the stored organization before choosing the list context, so a
  // personal list never flashes before the organization list.
  const isListLoading = !isLoaded || isLoading;

  const openNewProfile = () => {
    router.push(NEW_PROFILE_PATH);
  };

  const openProfile = (profile: AgentProfileListItem) => {
    router.push(
      getProfileOverviewPath(
        profile.id,
        profile.ownerType === 'organization' ? (organizationId ?? undefined) : undefined
      )
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-6 pt-4"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            colors={[colors.mutedForeground]}
            tintColor={colors.mutedForeground}
          />
        }
      >
        {isError && (
          <QueryError
            variant="server"
            placement="top"
            title={t('profiles.loadFailed')}
            onRetry={() => void refetch()}
            isRetrying={isRefetching}
          />
        )}
        {!isError && isListLoading && <ProfileListSkeleton />}
        {!isError && !isListLoading && sections.length === 0 && (
          <EmptyState
            icon={SlidersHorizontal}
            title={t('profiles.emptyTitle')}
            description={t('profiles.emptyDescription')}
            placement="top"
            action={
              <Button onPress={openNewProfile}>
                <Text>{t('profiles.newProfile')}</Text>
              </Button>
            }
          />
        )}
        {!isError && !isListLoading && sections.length > 0 && (
          <>
            {sections.map(section => (
              <View key={section.key} className="gap-3">
                {section.titleKey ? (
                  <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                    {t(section.titleKey)}
                  </Text>
                ) : null}
                {section.profiles.map((profile, index) => (
                  <ConfigureRow
                    key={profile.id}
                    icon={SlidersHorizontal}
                    title={profile.name}
                    subtitle={formatProfileCounts(profileCounts(profile))}
                    className="rounded-lg bg-secondary px-3"
                    last={index === section.profiles.length - 1}
                    trailing={renderDefaultStar({
                      isDefault: isEffectiveDefault(profile, effectiveDefaultId),
                      name: profile.name,
                      label: t('profiles.defaultSectionTitle'),
                      color: colors.primary,
                    })}
                    onPress={() => {
                      openProfile(profile);
                    }}
                  />
                ))}
              </View>
            ))}

            {/* Persistent create entry: the list keeps a create CTA at the end
                once profiles exist, so the flow never dead-ends. */}
            <Button onPress={openNewProfile}>
              <Plus size={16} color={colors.primaryForeground} />
              <Text>{t('profiles.newProfile')}</Text>
            </Button>
          </>
        )}
      </TabScreenScrollView>
    </View>
  );
}
