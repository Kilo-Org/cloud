import { useQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { CirclePlus, GitBranch, GitMerge, GitPullRequest, History } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  PERSONAL_SCOPE,
  useBitbucketReadiness,
  useGitHubStatus,
  useGitLabStatus,
} from '@/lib/hooks/use-code-reviewer';
import { useTRPC } from '@/lib/trpc';

const PLATFORM_ICONS: Record<ReviewerPlatform, typeof GitBranch> = {
  github: GitBranch,
  gitlab: GitMerge,
  bitbucket: GitPullRequest,
};

const ALL_PLATFORMS = ['github', 'gitlab', 'bitbucket'] as const;

function connectionSubtitle(status: { isLoading: boolean; data?: { connected: boolean } }) {
  if (status.isLoading) {
    return undefined;
  }
  return status.data?.connected ? 'Connected' : 'Not connected';
}

export function PlatformListScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const trpc = useTRPC();
  const isPersonal = scope === PERSONAL_SCOPE;

  const { data: orgs } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: !isPersonal,
  });
  const scopeTitle = isPersonal
    ? 'Personal'
    : (orgs?.find(org => org.organizationId === scope)?.organizationName ?? 'Organization');

  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const bitbucketReadiness = useBitbucketReadiness(scope);

  const statusFor = (platform: ReviewerPlatform) => {
    if (platform === 'gitlab') {
      return gitlabStatus;
    }
    if (platform === 'bitbucket') {
      return bitbucketReadiness;
    }
    return githubStatus;
  };

  const platforms = ALL_PLATFORMS.filter(
    platform => PLATFORM_CAPABILITIES[platform].scopes === 'all' || !isPersonal
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={scopeTitle} eyebrow="Code Reviewer" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Platforms
          </Text>
          <View>
            {platforms.map((platform, index) => {
              const status = statusFor(platform);
              return (
                <ConfigureRow
                  key={platform}
                  icon={PLATFORM_ICONS[platform]}
                  title={PLATFORM_CAPABILITIES[platform].label}
                  subtitle={connectionSubtitle(status)}
                  last={index === platforms.length - 1}
                  onPress={() => {
                    router.push(
                      `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/${platform}` as Href
                    );
                  }}
                />
              );
            })}
          </View>
        </View>

        <View className="mt-6 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Activity
          </Text>
          <View>
            <ConfigureRow
              icon={History}
              title="Recent reviews"
              onPress={() => {
                router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/reviews` as Href);
              }}
            />
            <ConfigureRow
              icon={CirclePlus}
              title="Manual review"
              last
              onPress={() => {
                router.push(
                  `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/manual-review` as Href
                );
              }}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
