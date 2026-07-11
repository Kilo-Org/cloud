import { type Href, useRouter } from 'expo-router';
import { Building2 } from 'lucide-react-native';
import { ActivityIndicator, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const PROFILE_HREF = '/(app)/(tabs)/(3_profile)' as Href;

type OrganizationBoundaryProps = Readonly<{
  /** Identity/org-list is still resolving — show a brief in-progress state instead of the empty state. */
  isResolving?: boolean;
}>;

/**
 * Content shown in place of an organization screen or sheet when the
 * persisted org selection doesn't resolve to a real membership (stale/
 * deleted org, or no org selected at all) — never renders `null`, so the
 * route is never blank. Callers own their own chrome (`ScreenHeader` for
 * full screens, nothing for form sheets) — this only renders the content.
 */
export function OrganizationBoundary({ isResolving }: OrganizationBoundaryProps = {}) {
  const router = useRouter();
  const colors = useThemeColors();

  if (isResolving) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  return (
    <EmptyState
      icon={Building2}
      title="Select an organization"
      description="This organization is no longer available. Choose one from your profile to continue."
      action={
        <Button
          variant="outline"
          onPress={() => {
            router.replace(PROFILE_HREF);
          }}
        >
          <Text>Back to profile</Text>
        </Button>
      }
    />
  );
}
