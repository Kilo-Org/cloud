import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { buildProfileSections, isEffectiveDefault } from '@/components/profiles/profile-list-model';
import {
  ProfileOwnerHeading,
  ProfileSectionHeading,
} from '@/components/profiles/profile-owner-heading';
import { profileOrganizationId, profileOwnerType } from '@/components/profiles/profile-owner-model';
import { selectProfilesListErrorView } from '@/components/profiles/profiles-list-error-view';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { IconButton } from '@/components/ui/icon-button';
import {
  Building2,
  GitBranch,
  type LucideIcon,
  Plus,
  SlidersHorizontal,
  Star,
  User,
} from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatProfileCountItems, profileCountItems } from '@/lib/profile-count-labels';
import { type AgentProfileListItem, useAgentProfileList } from '@/lib/hooks/use-agent-profiles';
import { useOrganization } from '@/lib/organization-context';
import {
  getNewProfilePath,
  getProfileOverviewPath,
  getRepoBindingsPath,
  type ProfileManagementStack,
} from '@/lib/profile-agent-navigation';

/**
 * The row's leading icon names its owner, the same split the web list row
 * makes (`ProfilesListDialog.tsx:372-376`): a building for an organization
 * profile, a person for a personal one.
 */
function ownerIcon(profile: AgentProfileListItem): LucideIcon {
  return profileOwnerType(profile) === 'organization' ? Building2 : User;
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

export function ProfilesListScreen({
  stack,
}: Readonly<{
  /** The Stack this screen is mounted in; the rows it opens stay in it. */
  stack: ProfileManagementStack;
}>) {
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
    error,
    isRefetching,
    refetch,
  } = useAgentProfileList(organizationId ?? undefined);
  // Reactive: a connectivity commit re-renders the error variant selection.
  const committedConnectivity = useCommittedConnectivityStatus();
  // An access outcome is terminal: naming it keeps the screen from reporting a
  // server fault and offering a Retry that cannot succeed.
  const listError = selectProfilesListErrorView({
    error: isError ? error : undefined,
    connectivity: committedConnectivity,
  });

  const sections = buildProfileSections({ orgProfiles, personalProfiles, isOrgContext });
  // Wait for the stored organization before choosing the list context, so a
  // personal list never flashes before the organization list.
  const isListLoading = !isLoaded || isLoading;

  const openNewProfile = () => {
    router.push(getNewProfilePath(stack));
  };

  const openProfile = (profile: AgentProfileListItem) => {
    router.push(
      getProfileOverviewPath(profile.id, {
        organizationId: profileOrganizationId(organizationId, profile),
        stack,
      })
    );
  };

  /**
   * The repo-defaults screen lists this context's bindings, so the list that
   * names the context opens it. The list is the route's parent, so its stack
   * repair finds it beneath and Back returns here; only the composer passes
   * `openedFrom`, which is what opts a caller out of that repair.
   */
  const openRepoBindings = () => {
    router.push(getRepoBindingsPath({ organizationId: organizationId ?? undefined, stack }));
  };

  // The heading names the group, not the screen the row opens, so it reuses
  // the catalog's own word instead of repeating the row's title.
  const repoDefaultsHeading = t('common.repositories');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profiles.title')}
        headerRight={
          <IconButton onPress={openNewProfile} accessibilityLabel={t('profiles.newProfile')}>
            <Plus size={22} color={colors.foreground} />
          </IconButton>
        }
      />
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
        {/* A failed refetch keeps the cached rows usable: the error banner sits
            above the content and only replaces it when there is nothing to
            show. The variant comes from the tRPC code, so an access denial is
            never reported as a server fault, and a terminal code offers no
            Retry action. */}
        {isError && (
          <QueryError
            variant={listError.variant}
            placement="top"
            // The scroll view already supplies the list's gutter and top pad;
            // the state's own pin air and padding would inset it 24 dp further
            // than the rows it replaces and leave a band above it.
            className="px-0 pt-0"
            title={listError.titleKey ? t(listError.titleKey) : undefined}
            onRetry={listError.showRetry ? () => void refetch() : undefined}
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
              <Button className={STATE_ACTION_CLASS} onPress={openNewProfile}>
                <Text>{t('profiles.newProfile')}</Text>
              </Button>
            }
          />
        )}
        {!isListLoading && sections.length > 0 && (
          <View className="gap-3">
            <ProfileSectionHeading>{t('profiles.title')}</ProfileSectionHeading>
            {sections.map(section => (
              <View key={section.key} className="gap-3">
                {section.titleKey ? <ProfileOwnerHeading owner={section.key} /> : null}
                {section.profiles.map((profile, index) => {
                  const subtitle = formatProfileCountItems(t, profileCountItems(profile)).join(
                    ' · '
                  );
                  const isDefault = isEffectiveDefault(profile, effectiveDefaultId);
                  // The star is a visual mark inside the pressable row, so the
                  // row's own name has to carry the state it announces. TalkBack
                  // never reads `accessibilityHint` (React Native maps it to the
                  // node's tooltip), so the action belongs in the name as well.
                  const accessibilityLabel = [
                    profile.name,
                    subtitle,
                    isDefault ? t('profiles.defaultSectionTitle') : '',
                    t('profiles.openHint'),
                  ]
                    .filter(part => part.length > 0)
                    .join(', ');
                  return (
                    <ConfigureRow
                      key={profile.id}
                      icon={ownerIcon(profile)}
                      title={profile.name}
                      subtitle={subtitle || undefined}
                      accessibilityLabel={accessibilityLabel}
                      className="rounded-lg bg-secondary px-3"
                      last={index === section.profiles.length - 1}
                      trailing={
                        isDefault ? (
                          <Star size={16} color={colors.primary} fill={colors.primary} />
                        ) : undefined
                      }
                      onPress={() => {
                        openProfile(profile);
                      }}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        )}
        {/* The defaults screen binds a repo to one of this list's profiles, so
            it needs a profile to point at: the entry appears with the rows and
            leaves the loading, error and empty states as they were. It is a
            settings entry rather than a profile, so it gets a group of its own
            with a heading, and the same gap above the heading and below it as
            the owner groups. */}
        {!isListLoading && sections.length > 0 && (
          <View className="gap-3">
            <ProfileSectionHeading>{repoDefaultsHeading}</ProfileSectionHeading>
            <ConfigureRow
              icon={GitBranch}
              title={t('profiles.repoBindings.entryLabel')}
              className="rounded-lg bg-secondary px-3"
              last
              onPress={openRepoBindings}
            />
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
